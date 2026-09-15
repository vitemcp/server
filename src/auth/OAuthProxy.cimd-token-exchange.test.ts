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
const { CIMD_DOCUMENT, CLIENT_ID } = vi.hoisted(() => {
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
        body: Readable.from([Buffer.from(JSON.stringify(CIMD_DOCUMENT))]),
        headers: { "content-type": "application/json" },
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
    proxy = new OAuthProxy({ ...baseConfig, encryptionKey: false });
  });

  afterEach(() => {
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
});
