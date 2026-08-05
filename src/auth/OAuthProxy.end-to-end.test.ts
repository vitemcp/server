import { afterEach, describe, expect, it } from "vitest";

import type { FakeAuthorizationServer } from "./fakeAuthorizationServer.js";

import { startFakeAuthorizationServer } from "./fakeAuthorizationServer.js";
import { OAuthProxy } from "./OAuthProxy.js";
import { PKCEUtils } from "./utils/pkce.js";

/**
 * End-to-end OAuth against a real authorization server over real sockets.
 *
 * Everywhere else the upstream leg is a `fetch` stub, which cannot fail when
 * the proxy sends something wrong — it returns a token regardless. Here the
 * counterparty verifies PKCE, enforces single-use codes, rotates refresh
 * tokens and returns `iss`, so mistakes actually surface.
 */
describe("OAuth proxy end-to-end", () => {
  let upstream: FakeAuthorizationServer | undefined;

  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  const makeProxy = (
    server: FakeAuthorizationServer,
    overrides: Record<string, unknown> = {},
  ) =>
    new OAuthProxy({
      allowedRedirectUriPatterns: ["https://client.example.com/*"],
      baseUrl: "http://localhost:4200",
      consentRequired: false,
      upstreamAuthorizationEndpoint: server.authorizationEndpoint,
      upstreamClientId: "proxy-client-id",
      upstreamClientSecret: "proxy-client-secret",
      upstreamIssuer: server.issuer,
      upstreamTokenEndpoint: server.tokenEndpoint,
      ...overrides,
    });

  const CALLBACK = "https://client.example.com/callback";

  /** Registers a client and walks authorize -> upstream -> callback. */
  const runFlow = async (proxy: OAuthProxy) => {
    const dcr = await proxy.registerClient({
      redirect_uris: [CALLBACK],
    });
    const pkce = PKCEUtils.generatePair("S256");

    const authorizeResponse = await proxy.authorize({
      client_id: dcr.client_id,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "read write",
    });

    // Follow the redirect to the upstream server for real.
    const upstreamUrl = authorizeResponse.headers.get("Location");
    expect(upstreamUrl).toBeTruthy();

    const upstreamResponse = await fetch(upstreamUrl!, { redirect: "manual" });
    const callbackUrl = upstreamResponse.headers.get("location");
    expect(callbackUrl).toBeTruthy();

    // Hand the upstream's redirect back to the proxy's callback handler.
    const callbackResponse = await proxy.handleCallback(
      new Request(callbackUrl!),
    );

    return { callbackResponse, dcr, pkce };
  };

  it("completes authorization code flow against a live server", async () => {
    upstream = await startFakeAuthorizationServer();
    const proxy = makeProxy(upstream);

    const { callbackResponse, dcr, pkce } = await runFlow(proxy);

    const clientRedirect = new URL(
      callbackResponse.headers.get("Location") ?? "",
    );
    const clientCode = clientRedirect.searchParams.get("code");
    expect(clientCode).toBeTruthy();

    const tokens = await proxy.exchangeAuthorizationCode({
      client_id: dcr.client_id,
      code: clientCode!,
      code_verifier: pkce.verifier,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK,
    });

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe("Bearer");

    // The upstream verified the proxy's own PKCE verifier — a stub could not.
    const upstreamToken = upstream.tokenRequests.at(0);
    expect(upstreamToken?.get("grant_type")).toBe("authorization_code");
    expect(upstreamToken?.get("code_verifier")).toBeTruthy();
  });

  it("sends a correct PKCE verifier upstream", async () => {
    upstream = await startFakeAuthorizationServer();
    const proxy = makeProxy(upstream);

    // The fake server rejects a bad verifier with invalid_grant, so reaching a
    // token at all proves the proxy computed and stored its challenge/verifier
    // pair correctly across the whole round trip.
    const { callbackResponse } = await runFlow(proxy);

    expect(callbackResponse.status).toBe(302);
    expect(
      new URL(callbackResponse.headers.get("Location") ?? "").searchParams.get(
        "code",
      ),
    ).toBeTruthy();

    const authorizeParams = upstream.authorizeRequests.at(0);
    expect(authorizeParams?.get("code_challenge_method")).toBe("S256");
  });

  it("rotates the upstream refresh token on refresh", async () => {
    upstream = await startFakeAuthorizationServer();
    const proxy = makeProxy(upstream);

    const { callbackResponse, dcr, pkce } = await runFlow(proxy);
    const clientCode = new URL(
      callbackResponse.headers.get("Location") ?? "",
    ).searchParams.get("code");

    const first = await proxy.exchangeAuthorizationCode({
      client_id: dcr.client_id,
      code: clientCode!,
      code_verifier: pkce.verifier,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK,
    });

    const refreshed = await proxy.exchangeRefreshToken({
      client_id: dcr.client_id,
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
    });

    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(first.access_token);

    // The upstream issued a second refresh token and invalidated the first;
    // presenting the old one again must fail at the upstream.
    expect(upstream.refreshTokens.length).toBe(2);

    await expect(
      proxy.exchangeRefreshToken({
        client_id: dcr.client_id,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token!,
      }),
    ).rejects.toThrow();
  });

  it("parses a form-encoded token response (GitHub Apps shape)", async () => {
    upstream = await startFakeAuthorizationServer({ formEncodedTokens: true });
    const proxy = makeProxy(upstream);

    const { callbackResponse, dcr, pkce } = await runFlow(proxy);
    const clientCode = new URL(
      callbackResponse.headers.get("Location") ?? "",
    ).searchParams.get("code");

    const tokens = await proxy.exchangeAuthorizationCode({
      client_id: dcr.client_id,
      code: clientCode!,
      code_verifier: pkce.verifier,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK,
    });

    // Not every provider answers JSON; the proxy has to handle both.
    expect(tokens.access_token).toBeTruthy();
  });

  it("refuses a callback whose iss names a different issuer", async () => {
    upstream = await startFakeAuthorizationServer({
      spoofIssuer: "https://evil-authorization-server.example",
    });
    const proxy = makeProxy(upstream);

    // RFC 9207: an attacker-controlled AS returning a code minted elsewhere is
    // the mix-up attack. The proxy must refuse to redeem it.
    //
    // Asserted on `description`, not `message`: OAuthProxyError puts the OAuth
    // error *code* in `message`, so matching there would pass for any
    // invalid_request and prove nothing about the issuer check.
    await expect(runFlow(proxy)).rejects.toMatchObject({
      code: "invalid_request",
      description: expect.stringMatching(/issuer/i),
    });
  });

  it("accepts a callback from a provider that omits iss", async () => {
    upstream = await startFakeAuthorizationServer({ omitIss: true });
    const proxy = makeProxy(upstream);

    // `iss` is validated only when present — requiring it would break every
    // provider that has not adopted RFC 9207.
    const { callbackResponse } = await runFlow(proxy);
    expect(callbackResponse.status).toBe(302);
  });

  it("keeps upstream credentials separate per issuer", async () => {
    upstream = await startFakeAuthorizationServer();
    const second = await startFakeAuthorizationServer();

    try {
      // Two proxies sharing one storage backend must not see each other's
      // records: storage keys are namespaced by issuer (SEP-2352).
      const { MemoryTokenStorage } = await import("./utils/tokenStore.js");
      const shared = new MemoryTokenStorage();

      const proxyA = makeProxy(upstream, { tokenStorage: shared });
      const proxyB = makeProxy(second, { tokenStorage: shared });

      const a = await runFlow(proxyA);
      const codeA = new URL(
        a.callbackResponse.headers.get("Location") ?? "",
      ).searchParams.get("code");

      // proxyB must not be able to redeem a code minted under proxyA's issuer.
      await expect(
        proxyB.exchangeAuthorizationCode({
          client_id: a.dcr.client_id,
          code: codeA!,
          code_verifier: a.pkce.verifier,
          grant_type: "authorization_code",
          redirect_uri: CALLBACK,
        }),
      ).rejects.toThrow();

      shared.destroy();
    } finally {
      await second.close();
    }
  });
});
