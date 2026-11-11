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

    // `URL` keeps an IPv6 literal's brackets in `hostname`, so `[::1]` never
    // equalled the bare `::1` it was compared with, and a client redirecting
    // to IPv6 loopback was taken for a web application.
    it("infers application_type native for an IPv6 loopback redirect URI", async () => {
      const proxy = new OAuthProxy({
        allowedRedirectUriPatterns: ["http://[::1]:*"],
        baseUrl: "http://localhost:4200",
        upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
        upstreamClientId: "id",
        upstreamClientSecret: "secret",
        upstreamTokenEndpoint: "https://provider.com/oauth/token",
      });
      const app = createOAuthRouter({ proxy });

      const response = await post(app, "/oauth/register", {
        body: JSON.stringify({
          redirect_uris: ["http://[::1]:3000/callback"],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);
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

  describe("callback and consent errors", () => {
    it("answers a callback with an unknown state as the OAuth error it is", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await get(app, "/oauth/callback?code=c&state=unknown");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "Invalid or expired state",
      });
    });

    it("passes on a code the provider refused with a 200", async () => {
      const proxy = makeProxy();
      const app = createOAuthRouter({ proxy });
      const { client_id } = await proxy.registerClient({
        redirect_uris: ["https://client.example.com/callback"],
      });
      const authorization = await get(
        app,
        `/oauth/authorize?${new URLSearchParams({
          client_id,
          redirect_uri: "https://client.example.com/callback",
          response_type: "code",
          state: "client-state",
        })}`,
      );
      const state = new URL(
        authorization.headers.get("Location")!,
      ).searchParams.get("state")!;

      // GitHub refuses a code this way, with a 200.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            "error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.",
            {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              status: 200,
            },
          ),
      );

      try {
        const response = await get(
          app,
          `/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
      } finally {
        fetchSpy.mockRestore();
        proxy.destroy();
      }
    });

    it("answers a consent submission with no transaction as the OAuth error it is", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/consent", {
        body: new URLSearchParams({ action: "approve" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "Missing transaction_id",
      });
    });

    it("leaves a failure that is not an OAuth error to answer as one", async () => {
      const proxy = makeProxy();
      vi.spyOn(proxy, "handleCallback").mockRejectedValue(
        new Error("storage is down"),
      );
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const app = createOAuthRouter({ proxy });

      try {
        const response = await get(app, "/oauth/callback?code=c&state=s");

        expect(response.status).toBe(500);
      } finally {
        consoleSpy.mockRestore();
        proxy.destroy();
      }
    });
  });

  /**
   * RFC 6749 §5.1 / RFC 7591 §3.2.1. A token or `client_secret` that an
   * intermediary is allowed to retain is a credential leak, so these headers
   * are asserted on both endpoints and on both outcomes.
   */
  describe("credential responses are not storable", () => {
    const expectNoStore = (response: Response) => {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
    };

    it("marks a registration response carrying client_secret", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      const response = await post(app, "/oauth/register", {
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(201);
      expect(
        ((await response.json()) as Record<string, unknown>).client_secret,
      ).toEqual(expect.any(String));
      expectNoStore(response);
    });

    it("marks a token response", async () => {
      const proxy = makeProxy();
      const spy = vi
        .spyOn(proxy, "exchangeAuthorizationCode")
        .mockResolvedValue({
          access_token: "t",
          refresh_token: "r",
          token_type: "Bearer",
        } as never);
      const app = createOAuthRouter({ proxy });

      const response = await post(app, "/oauth/token", {
        body: new URLSearchParams({
          code: "abc",
          grant_type: "authorization_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expectNoStore(response);
      spy.mockRestore();
    });

    it("marks the error paths of both endpoints too", async () => {
      const app = createOAuthRouter({ proxy: makeProxy() });

      // Registration error: no redirect_uris.
      expectNoStore(
        await post(app, "/oauth/register", {
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );

      // Token error: an authorization code that was never issued.
      expectNoStore(
        await post(app, "/oauth/token", {
          body: new URLSearchParams({
            client_id: "nobody",
            code: "never-issued",
            grant_type: "authorization_code",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
      );

      // Over the body cap, rejected before either handler runs.
      expectNoStore(
        await post(app, "/oauth/token", {
          body: "x".repeat(OAUTH_PROXY_MAX_BODY_SIZE + 1),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
      );
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

    // The form's action was `/oauth/consent` whatever the router was mounted
    // under, so with a base path Approve went to a path no route answers.
    it.each(["", "/issuer1", "/tenant/team"])(
      "has the consent form post to the route beside it under base path '%s'",
      async (basePath) => {
        const proxy = new OAuthProxy({
          allowedRedirectUriPatterns: ["https://client.example.com/*"],
          baseUrl: `http://localhost:4200${basePath}`,
          upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
          upstreamClientId: "upstream-id",
          upstreamClientSecret: "upstream-secret",
          upstreamTokenEndpoint: "https://provider.com/oauth/token",
        });
        const app = createOAuthRouter({ basePath, proxy });

        try {
          const client = await proxy.registerClient({
            redirect_uris: ["https://client.example.com/callback"],
          });
          const authorizeUrl = `http://localhost:4200${basePath}/oauth/authorize?${new URLSearchParams(
            {
              client_id: client.client_id,
              redirect_uri: "https://client.example.com/callback",
              response_type: "code",
              state: "client-state",
            },
          )}`;

          const page = await app.fetch(new Request(authorizeUrl));
          expect(page.status).toBe(200);

          const html = await page.text();
          const action = /<form method="POST" action="([^"]+)"/.exec(html)?.[1];
          const transactionId = /name="transaction_id" value="([^"]+)"/.exec(
            html,
          )?.[1];

          // Resolved as a browser resolves it: against the page the form is on.
          const consentUrl = new URL(action!, authorizeUrl);
          expect(consentUrl.pathname).toBe(`${basePath}/oauth/consent`);

          const approved = await app.fetch(
            new Request(consentUrl, {
              body: new URLSearchParams({
                action: "approve",
                transaction_id: transactionId!,
              }),
              method: "POST",
            }),
          );

          expect(approved.status).toBe(302);
          expect(new URL(approved.headers.get("location")!).origin).toBe(
            "https://provider.com",
          );
        } finally {
          proxy.destroy();
        }
      },
    );
  });
});
