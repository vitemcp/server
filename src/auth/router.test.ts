import { describe, expect, it, vi } from "vitest";

import { OAuthProxy } from "./OAuthProxy.js";
import { createOAuthRouter, OAUTH_PROXY_MAX_BODY_SIZE } from "./router.js";

/**
 * Direct coverage for the OAuth HTTP surface.
 *
 * These endpoints were previously only exercised through a running ViteMCP
 * server, which meant the router's own error handling, body caps and metadata
 * routing were never asserted in isolation.
 */
const makeProxy = () =>
  new OAuthProxy({
    allowedRedirectUriPatterns: ["https://client.example.com/*"],
    baseUrl: "http://localhost:4200",
    consentRequired: false,
    upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
    upstreamClientId: "upstream-id",
    upstreamClientSecret: "upstream-secret",
    upstreamTokenEndpoint: "https://provider.com/oauth/token",
  });

const post = (
  app: ReturnType<typeof createOAuthRouter>,
  path: string,
  init: RequestInit,
) => app.fetch(new Request(`http://localhost:4200${path}`, init));

const get = (app: ReturnType<typeof createOAuthRouter>, path: string) =>
  app.fetch(new Request(`http://localhost:4200${path}`));

describe("OAuth router", () => {
  describe("dynamic client registration", () => {
    it("registers a client and returns 201", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/register", {
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.client_id).toEqual(expect.any(String));
      // Inferred from a non-loopback redirect URI (SEP-837).
      expect(body.application_type).toBe("web");
    });

    it("infers application_type native for loopback redirect URIs", async () => {
      const proxy = new OAuthProxy({
        baseUrl: "http://localhost:4200",
        upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
        upstreamClientId: "id",
        upstreamClientSecret: "secret",
        upstreamTokenEndpoint: "https://provider.com/oauth/token",
      });
      const app = createOAuthRouter({ proxy });

      const response = await post(app, "/oauth/register", {
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:3000/callback"],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(
        ((await response.json()) as Record<string, unknown>).application_type,
      ).toBe("native");
    });

    it("rejects a body over the size cap without parsing it", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/register", {
        body: "x".repeat(OAUTH_PROXY_MAX_BODY_SIZE + 1),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as Record<string, unknown>).error).toBe(
        "invalid_request",
      );
    });

    it("rejects malformed JSON", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/register", {
        body: "{ not json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(400);
    });

    it("surfaces a registration error as an OAuth error body", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      // No redirect_uris: the proxy rejects with invalid_client_metadata, and
      // the router must render that rather than a bare 500.
      const response = await post(app, "/oauth/register", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as Record<string, unknown>).error,
      ).toEqual(expect.any(String));
    });
  });

  describe("token endpoint", () => {
    it("accepts client credentials from a Basic auth header", async () => {
      const proxy = makeProxy();
      const spy = vi
        .spyOn(proxy, "exchangeAuthorizationCode")
        .mockResolvedValue({
          access_token: "t",
          token_type: "Bearer",
        } as never);
      const app = createOAuthRouter({ proxy });

      await post(app, "/oauth/token", {
        body: new URLSearchParams({
          code: "abc",
          grant_type: "authorization_code",
        }).toString(),
        headers: {
          Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });

      // RFC 6749 §2.3.1: credentials may travel in the header instead of body.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ client_id: "id", client_secret: "secret" }),
      );
      spy.mockRestore();
    });

    it("routes refresh_token grants to the refresh path", async () => {
      const proxy = makeProxy();
      const spy = vi.spyOn(proxy, "exchangeRefreshToken").mockResolvedValue({
        access_token: "t",
        token_type: "Bearer",
      } as never);
      const app = createOAuthRouter({ proxy });

      await post(app, "/oauth/token", {
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "r",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("rejects an over-limit token body", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/token", {
        body: "x".repeat(OAUTH_PROXY_MAX_BODY_SIZE + 1),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      expect(response.status).toBe(400);
    });
  });

  describe("discovery metadata", () => {
    it("serves authorization server metadata in snake_case", async () => {
      const proxy = makeProxy();
      const app = createOAuthRouter({
        authorizationServer: proxy.getAuthorizationServerMetadata(),
        proxy,
      });

      const response = await get(
        app,
        "/.well-known/oauth-authorization-server",
      );

      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      // RFC 8414 is snake_case on the wire; the config is camelCase.
      expect(body.authorization_endpoint).toEqual(expect.any(String));
      expect(body.authorization_response_iss_parameter_supported).toBe(true);
      expect(body.client_id_metadata_document_supported).toBe(true);
    });

    it("serves metadata without a proxy", async () => {
      const app = createOAuthRouter({
        authorizationServer: { issuer: "https://as.example.com" },
      });

      const response = await get(
        app,
        "/.well-known/oauth-authorization-server",
      );

      expect(response.status).toBe(200);
    });

    it("404s an unrelated well-known sub-path", async () => {
      const proxy = makeProxy();
      const app = createOAuthRouter({
        endpoint: "/mcp",
        protectedResource: { resource: "https://mcp.example.com/mcp" },
        proxy,
      });

      // The scoped path and the root fallback are served; anything else is not.
      expect(
        (await get(app, "/.well-known/oauth-protected-resource/mcp")).status,
      ).toBe(200);
      expect(
        (await get(app, "/.well-known/oauth-protected-resource")).status,
      ).toBe(200);
      expect(
        (await get(app, "/.well-known/oauth-protected-resource/wrong")).status,
      ).toBe(404);
    });

    it("scopes endpoints under a base path", async () => {
      const proxy = makeProxy();
      const app = createOAuthRouter({ basePath: "/issuer1", proxy });

      const response = await post(app, "/issuer1/oauth/register", {
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);
      // The unscoped path must not also answer.
      expect((await get(app, "/oauth/register")).status).toBe(404);
    });
  });
});
