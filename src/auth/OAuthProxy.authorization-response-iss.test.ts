/**
 * RFC 9207: every authorization response the proxy sends back to a client —
 * the code on success, the error when consent is denied — names the issuer in
 * `iss`, so the client can tell which authorization server answered and detect
 * a mix-up. The metadata flag that tells clients to check it is covered in
 * `router.test.ts`, and the upstream's own `iss` in
 * `OAuthProxy.end-to-end.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { FakeAuthorizationServer } from "./fakeAuthorizationServer.js";

import { startFakeAuthorizationServer } from "./fakeAuthorizationServer.js";
import { OAuthProxy } from "./OAuthProxy.js";
import { PKCEUtils } from "./utils/pkce.js";

const CALLBACK = "https://client.example.com/callback";

describe("OAuthProxy authorization response issuer (RFC 9207)", () => {
  let upstream: FakeAuthorizationServer | undefined;
  const proxies: OAuthProxy[] = [];

  afterEach(async () => {
    for (const proxy of proxies) {
      proxy.destroy();
    }
    proxies.length = 0;

    await upstream?.close();
    upstream = undefined;
  });

  const makeProxy = async (consentRequired: boolean) => {
    upstream = await startFakeAuthorizationServer();

    const proxy = new OAuthProxy({
      allowedRedirectUriPatterns: ["https://client.example.com/*"],
      baseUrl: "http://localhost:4200",
      consentRequired,
      upstreamAuthorizationEndpoint: upstream.authorizationEndpoint,
      upstreamClientId: "proxy-client-id",
      upstreamClientSecret: "proxy-client-secret",
      upstreamIssuer: upstream.issuer,
      upstreamTokenEndpoint: upstream.tokenEndpoint,
    });
    proxies.push(proxy);

    return proxy;
  };

  /** Registers a client and starts an authorization, as the client would. */
  const authorize = async (proxy: OAuthProxy) => {
    const { client_id } = await proxy.registerClient({
      redirect_uris: [CALLBACK],
    });
    const pkce = PKCEUtils.generatePair("S256");

    return proxy.authorize({
      client_id,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      response_type: "code",
      state: "client-state",
    });
  };

  const redirectParams = (response: Response) =>
    new URL(response.headers.get("Location") ?? "").searchParams;

  it("names the issuer on the redirect that carries the code", async () => {
    const proxy = await makeProxy(false);

    const upstreamResponse = await fetch(
      (await authorize(proxy)).headers.get("Location")!,
      { redirect: "manual" },
    );
    const callback = await proxy.handleCallback(
      new Request(upstreamResponse.headers.get("location")!),
    );

    expect(redirectParams(callback).get("code")).toBeTruthy();
    expect(redirectParams(callback).get("iss")).toBe(
      proxy.getAuthorizationServerMetadata().issuer,
    );
  });

  it("names the issuer on the redirect that reports a denied consent", async () => {
    const proxy = await makeProxy(true);

    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(
      await (await authorize(proxy)).text(),
    )![1];
    const denied = await proxy.handleConsent(
      new Request("http://localhost:4200/oauth/consent", {
        body: new URLSearchParams({
          action: "deny",
          transaction_id: transactionId,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
    );

    expect(redirectParams(denied).get("error")).toBe("access_denied");
    expect(redirectParams(denied).get("iss")).toBe(
      proxy.getAuthorizationServerMetadata().issuer,
    );
  });
});
