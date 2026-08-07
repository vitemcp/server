/**
 * The proxy accepts S256 only unless `allowPlainPkce` is set.
 *
 * With `plain` the code challenge *is* the code verifier, so the secret that
 * redeems an authorization code travels in the authorization request — through
 * browser history, referrer headers and proxy logs. RFC 7636 §4.2 requires S256
 * of any client that can compute a SHA-256 digest, and OAuth 2.1 (which the MCP
 * authorization spec builds on) drops `plain` entirely.
 *
 * These tests pin both halves: what the metadata advertises, and what
 * /oauth/authorize actually enforces.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AuthorizationParams } from "./types.js";

import { OAuthProxy } from "./OAuthProxy.js";

const baseConfig = {
  allowedRedirectUriPatterns: ["https://client.example.com/*"],
  baseUrl: "http://localhost:4200",
  consentRequired: false,
  encryptionKey: false as const,
  redirectPath: "/oauth/callback",
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: "upstream-client-id",
  upstreamClientSecret: "upstream-client-secret",
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
};

const REDIRECT_URI = "https://client.example.com/callback";

/** authorize() requires a registered client, so every case starts with DCR. */
async function authorizeWith(
  proxy: OAuthProxy,
  overrides: Partial<AuthorizationParams>,
): Promise<Response> {
  const client = await proxy.registerClient({
    redirect_uris: [REDIRECT_URI],
  });

  return proxy.authorize({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "client-state",
    ...overrides,
  } as AuthorizationParams);
}

describe("OAuthProxy PKCE challenge methods", () => {
  describe("by default (S256 only)", () => {
    let proxy: OAuthProxy;

    beforeEach(() => {
      proxy = new OAuthProxy(baseConfig);
    });

    it("advertises S256 and not plain", () => {
      expect(
        proxy.getAuthorizationServerMetadata().codeChallengeMethodsSupported,
      ).toEqual(["S256"]);
    });

    it("rejects code_challenge_method=plain at the authorization endpoint", async () => {
      await expect(
        authorizeWith(proxy, {
          code_challenge: "a".repeat(43),
          code_challenge_method: "plain",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        description: expect.stringContaining("plain"),
      });
    });

    // Rejecting here rather than at /oauth/token matters: the token endpoint
    // reads an unknown method as a failed verifier check, so the client would
    // get an `invalid_grant` only after the user finished the upstream login.
    it("rejects an unknown challenge method", async () => {
      await expect(
        authorizeWith(proxy, {
          code_challenge: "a".repeat(43),
          code_challenge_method: "S512",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        description: expect.stringContaining("S512"),
      });
    });

    it("accepts S256", async () => {
      const response = await authorizeWith(proxy, {
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "https://provider.com/oauth/authorize",
      );
    });

    // A request carrying no challenge at all never reaches the method check —
    // PKCE is optional at the proxy, and the token endpoint skips verifier
    // validation when no challenge was stored.
    it("leaves a request without a code_challenge alone", async () => {
      const response = await authorizeWith(proxy, {});

      expect(response.status).toBe(302);
    });
  });

  describe("with allowPlainPkce enabled", () => {
    let proxy: OAuthProxy;

    beforeEach(() => {
      proxy = new OAuthProxy({ ...baseConfig, allowPlainPkce: true });
    });

    it("advertises plain alongside S256", () => {
      expect(
        proxy.getAuthorizationServerMetadata().codeChallengeMethodsSupported,
      ).toEqual(["S256", "plain"]);
    });

    it("accepts code_challenge_method=plain", async () => {
      const response = await authorizeWith(proxy, {
        code_challenge: "a".repeat(43),
        code_challenge_method: "plain",
      });

      expect(response.status).toBe(302);
    });

    it("still rejects an unknown challenge method", async () => {
      await expect(
        authorizeWith(proxy, {
          code_challenge: "a".repeat(43),
          code_challenge_method: "S512",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });
  });
});
