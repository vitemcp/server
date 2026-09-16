/**
 * Regression tests: a Client ID Metadata Document client must be resolvable on
 * every leg of the flow, not just at `authorize()`.
 *
 * The pre-patch behaviour was:
 *   - `authorize()` resolved a URL-formatted `client_id` through CIMD.
 *   - `exchangeAuthorizationCode()` looked the same `client_id` up with
 *     `getRegisteredClientByClientId()`, which only knows DCR-issued rows, and
 *     threw `invalid_client / Unknown client_id` for every CIMD client.
 *
 * The two legs therefore disagreed: consent succeeded and the exchange that
 * immediately followed could never complete. CIMD is enabled by default, so
 * this affected any native client using it — Claude Code among them, whose
 * document declares the portless loopback URIs RFC 8252 §7.3 describes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationParams } from "./types.js";

import { OAuthProxy } from "./OAuthProxy.js";

// `vi.mock` is hoisted above module initialisation, so the document the factory
// serves has to be hoisted with it.
const { CIMD_DOCUMENT, CLIENT_ID, served } = vi.hoisted(() => {
  const clientId = "https://client.example.com/metadata.json";

  return {
    CIMD_DOCUMENT: {
      client_id: clientId,
      client_name: "Test Native Client",
      grant_types: ["authorization_code", "refresh_token"],
      // Mirrors Claude Code's published document: portless loopback redirects.
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    CLIENT_ID: clientId,
    // Overrides for tests that need the document to change under the proxy.
    served: {
      cacheControl: undefined as string | undefined,
      document: undefined as Record<string, unknown> | undefined,
    },
  };
});

// The resolver fetches through undici's `request` with an SSRF-safe dispatcher
// (a real server is not reachable from a test: the guard refuses loopback), so
// the document is served at that boundary.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();

  return {
    ...actual,
    request: vi.fn(async (url: unknown) => {
      if (String(url) !== CLIENT_ID) {
        throw new Error(`unexpected request: ${String(url)}`);
      }

      const { Readable } = await import("node:stream");

      return {
        body: Readable.from([
          Buffer.from(JSON.stringify(served.document ?? CIMD_DOCUMENT)),
        ]),
        headers: {
          ...(served.cacheControl
            ? { "cache-control": served.cacheControl }
            : {}),
          "content-type": "application/json",
        },
        statusCode: 200,
      };
    }),
  };
});

/** The ephemeral port a native client binds at run time. */
const EPHEMERAL_REDIRECT = "http://localhost:52430/callback";

const baseConfig = {
  baseUrl: "http://localhost:4200",
  consentRequired: false,
  redirectPath: "/oauth/callback",
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: "upstream-id",
  upstreamClientSecret: "upstream-secret",
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
};

const buildAuthParams = (redirectUri: string): AuthorizationParams => ({
  client_id: CLIENT_ID,
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid",
  state: "state-123",
});

describe("OAuthProxy CIMD client resolution across legs", () => {
  let proxy: OAuthProxy;

  beforeEach(() => {
    served.cacheControl = undefined;
    served.document = undefined;
    proxy = new OAuthProxy({ ...baseConfig, encryptionKey: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    proxy.destroy();
  });

  it("authorizes a portless CIMD declaration against an ephemeral port (RFC 8252 §7.3)", async () => {
    await expect(
      proxy.authorize(buildAuthParams(EPHEMERAL_REDIRECT)),
    ).resolves.toBeDefined();
  });

  it("still rejects a redirect_uri the document does not declare", async () => {
    await expect(
      proxy.authorize(buildAuthParams("http://evil.attacker.com/steal")),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("does not reject a CIMD client at the token endpoint as an unknown client", async () => {
    await proxy.authorize(buildAuthParams(EPHEMERAL_REDIRECT));

    // A bogus code: the exchange must fail on the CODE, not on the client.
    // Before the fix this threw invalid_client / "Unknown client_id", so the
    // exchange could never be reached at all.
    await expect(
      proxy.exchangeAuthorizationCode({
        client_id: CLIENT_ID,
        code: "not-a-real-code",
        code_verifier: "a".repeat(64),
        grant_type: "authorization_code",
        redirect_uri: EPHEMERAL_REDIRECT,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it('advertises "none" as a token endpoint auth method when CIMD is enabled', () => {
    expect(
      proxy.getAuthorizationServerMetadata().tokenEndpointAuthMethodsSupported,
    ).toContain("none");
  });

  it('omits "none" when CIMD is disabled', () => {
    const dcrOnly = new OAuthProxy({
      ...baseConfig,
      clientIdMetadata: { enabled: false },
      encryptionKey: false,
    });

    try {
      expect(
        dcrOnly.getAuthorizationServerMetadata()
          .tokenEndpointAuthMethodsSupported,
      ).not.toContain("none");
    } finally {
      dcrOnly.destroy();
    }
  });

  it("keeps rejecting a genuinely unknown client_id at the token endpoint", async () => {
    await expect(
      proxy.exchangeAuthorizationCode({
        client_id: "never-registered",
        code: "not-a-real-code",
        code_verifier: "a".repeat(64),
        grant_type: "authorization_code",
        redirect_uri: EPHEMERAL_REDIRECT,
      }),
    ).rejects.toMatchObject({ code: "invalid_client" });
  });
  /**
   * Drive a whole authorization: authorize, then hand the upstream callback
   * back. The upstream token endpoint is stubbed, so this exercises the
   * callback leg — where the transaction's concrete callback URL is checked
   * against what the client declares — rather than stopping at authorize().
   */
  const roundTrip = async (redirectUri: string): Promise<Response> => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "upstream-access-token",
              expires_in: 3600,
              refresh_token: "upstream-refresh-token",
              scope: "openid",
              token_type: "Bearer",
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
      ),
    );

    const authorizeResponse = await proxy.authorize(
      buildAuthParams(redirectUri),
    );
    const upstreamUrl = new URL(
      authorizeResponse.headers.get("location") as string,
    );
    const state = upstreamUrl.searchParams.get("state") as string;

    return await proxy.handleCallback(
      new Request(
        `${baseConfig.baseUrl}${baseConfig.redirectPath}?code=upstream-code&state=${state}`,
      ),
    );
  };

  it("completes the round trip to the ephemeral port the client bound", async () => {
    const callback = await roundTrip(EPHEMERAL_REDIRECT);
    const location = new URL(callback.headers.get("location") as string);

    expect(location.origin).toBe("http://localhost:52430");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  /**
   * A native client binds a fresh ephemeral port on every run, so the second
   * login of the same client presents a port the first one never used. Both
   * legs have to agree about it: resolving the document once and remembering
   * the first port makes authorize() pass and the callback fail.
   */
  it("completes the round trip again on a different ephemeral port", async () => {
    await roundTrip(EPHEMERAL_REDIRECT);

    const callback = await roundTrip("http://localhost:61234/callback");
    const location = new URL(callback.headers.get("location") as string);

    expect(location.origin).toBe("http://localhost:61234");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  /**
   * Removing a redirect URI from the document is how a CIMD client revokes it.
   * That only works if the document is read again rather than frozen into the
   * registered-client store on first resolve.
   */
  it("stops accepting a redirect URI the document no longer declares", async () => {
    // `no-store` so the resolver's cache does not stand in for the store.
    served.cacheControl = "no-store";

    await expect(
      proxy.authorize(buildAuthParams(EPHEMERAL_REDIRECT)),
    ).resolves.toBeDefined();

    // The loopback callback is withdrawn; the document itself stays valid, so
    // the rejection has to come from the redirect_uri check.
    served.document = {
      ...CIMD_DOCUMENT,
      redirect_uris: ["http://localhost/other"],
    };

    await expect(
      proxy.authorize(buildAuthParams(EPHEMERAL_REDIRECT)),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
