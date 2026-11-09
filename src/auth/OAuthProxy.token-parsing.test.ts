/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";

import { OAuthProxy } from "./OAuthProxy.js";
import { PKCEUtils } from "./utils/pkce.js";

/**
 * A passthrough-mode refresh request the proxy will forward: the upstream
 * refresh token is handed out by a code exchange, which binds it to the
 * client. No upstream call is made, so `fetch` can be mocked to fail first.
 */
const issuePassthroughRefreshRequest = async (
  proxy: OAuthProxy,
  refreshToken: string,
) => {
  const redirectUri = "http://localhost:3000/callback";
  const dcr = await proxy.registerClient({ redirect_uris: [redirectUri] });
  const pkce = PKCEUtils.generatePair("S256");
  const transaction = await (proxy as any).createTransaction({
    client_id: dcr.client_id,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
  });
  const code = await (proxy as any).generateAuthorizationCode(transaction, {
    accessToken: "upstream-access-token",
    expiresIn: 3600,
    issuedAt: new Date(),
    refreshToken,
    scope: [],
    tokenType: "Bearer",
  });

  await proxy.exchangeAuthorizationCode({
    client_id: dcr.client_id,
    client_secret: dcr.client_secret,
    code,
    code_verifier: pkce.verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  return {
    client_id: dcr.client_id,
    client_secret: dcr.client_secret,
    grant_type: "refresh_token" as const,
    refresh_token: refreshToken,
  };
};

/**
 * The request a provider sends the user back to the proxy with, for an
 * authorization started there. Handling it exchanges the code upstream.
 */
const upstreamCallback = async (proxy: OAuthProxy): Promise<Request> => {
  const dcr = await proxy.registerClient({
    redirect_uris: ["http://localhost:3000/callback"],
  });
  const authorization = await proxy.authorize({
    client_id: dcr.client_id,
    redirect_uri: "http://localhost:3000/callback",
    response_type: "code",
    state: "client-state",
  });
  const state = new URL(
    authorization.headers.get("Location")!,
  ).searchParams.get("state")!;

  return new Request(
    `https://proxy.example.com/oauth/callback?code=upstream-code&state=${encodeURIComponent(state)}`,
  );
};

describe("OAuthProxy - Token Response Parsing", () => {
  const baseConfig = {
    baseUrl: "https://proxy.example.com",
    consentRequired: false,
    upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
    upstreamClientId: "upstream-client-id",
    upstreamClientSecret: "upstream-client-secret",
    upstreamTokenEndpoint: "https://provider.com/oauth/token",
  };

  describe("parseTokenResponse", () => {
    it("should parse JSON token response (standard OAuth providers)", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "test_access_token",
          expires_in: 3600,
          id_token: "test_id_token",
          refresh_token: "test_refresh_token",
          scope: "read write",
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test_access_token");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.id_token).toBe("test_id_token");
      expect(tokens.refresh_token).toBe("test_refresh_token");
      expect(tokens.scope).toBe("read write");
      expect(tokens.token_type).toBe("Bearer");

      proxy.destroy();
    });

    it("should parse URL-encoded token response (GitHub Apps format)", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=ghu_redacted&expires_in=28800&refresh_token=ghr_redacted&refresh_token_expires_in=15724800&scope=&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("ghu_redacted");
      expect(tokens.expires_in).toBe(28800);
      expect(tokens.refresh_token).toBe("ghr_redacted");
      expect(tokens.scope).toBeUndefined(); // Empty string is treated as undefined
      expect(tokens.token_type).toBe("bearer");

      proxy.destroy();
    });

    it("should handle URL-encoded response without optional fields", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=ghu_test&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("ghu_test");
      expect(tokens.token_type).toBe("bearer");
      expect(tokens.expires_in).toBeUndefined();
      expect(tokens.refresh_token).toBeUndefined();
      expect(tokens.scope).toBeUndefined();
      expect(tokens.id_token).toBeUndefined();

      proxy.destroy();
    });

    it("should fallback to JSON when Content-Type is missing", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "test_token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          // No Content-Type header
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test_token");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.token_type).toBe("Bearer");

      proxy.destroy();
    });

    it("should handle Content-Type with charset parameter", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&expires_in=3600&token_type=bearer",
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.token_type).toBe("bearer");

      proxy.destroy();
    });

    it("should parse expires_in as number from URL-encoded format", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&expires_in=28800&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.expires_in).toBe(28800);
      expect(typeof tokens.expires_in).toBe("number");

      proxy.destroy();
    });

    it("should handle URL-encoded response with empty scope", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&scope=&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test");
      expect(tokens.scope).toBeUndefined(); // Empty string is treated as undefined
      expect(tokens.token_type).toBe("bearer");

      proxy.destroy();
    });

    it("should handle JSON response with all optional fields present", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "access_123",
          expires_in: 7200,
          id_token: "id_token_xyz",
          refresh_token: "refresh_456",
          scope: "openid profile email",
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json; charset=utf-8" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("access_123");
      expect(tokens.expires_in).toBe(7200);
      expect(tokens.id_token).toBe("id_token_xyz");
      expect(tokens.refresh_token).toBe("refresh_456");
      expect(tokens.scope).toBe("openid profile email");
      expect(tokens.token_type).toBe("Bearer");

      proxy.destroy();
    });

    it("should throw validation error for missing access_token in JSON", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          expires_in: 3600,
          token_type: "Bearer",
          // missing access_token
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should throw validation error for invalid expires_in type in URL-encoded", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&expires_in=invalid&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should throw validation error for negative expires_in", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "test",
          expires_in: -100,
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should throw validation error for missing access_token in URL-encoded", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response("expires_in=3600&token_type=bearer", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        status: 200,
      });

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should throw validation error for non-integer expires_in", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "test",
          expires_in: 3600.5, // float instead of integer
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should throw validation error for zero expires_in", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "test",
          expires_in: 0, // zero is not positive
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should handle URL-encoded response with id_token", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&id_token=eyJhbGc&expires_in=3600&token_type=bearer",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test");
      expect(tokens.id_token).toBe("eyJhbGc");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.token_type).toBe("bearer");

      proxy.destroy();
    });

    it("should handle JSON response with only required field", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: "minimal_token",
          // all other fields optional
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("minimal_token");
      expect(tokens.expires_in).toBeUndefined();
      expect(tokens.id_token).toBeUndefined();
      expect(tokens.refresh_token).toBeUndefined();
      expect(tokens.scope).toBeUndefined();
      expect(tokens.token_type).toBeUndefined();

      proxy.destroy();
    });

    it("should throw validation error for wrong type of access_token", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({
          access_token: 12345, // number instead of string
          token_type: "Bearer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      await expect(
        (proxy as any).parseTokenResponse(mockResponse),
      ).rejects.toThrow();

      proxy.destroy();
    });

    it("should handle mixed case Content-Type header", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        "access_token=test&expires_in=3600&token_type=bearer",
        {
          headers: {
            "Content-Type": "Application/X-Www-Form-Urlencoded",
          },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("test");
      expect(tokens.expires_in).toBe(3600);

      proxy.destroy();
    });

    it("should throw the error a URL-encoded 200 response reports, instead of reading it as a token", async () => {
      const proxy = new OAuthProxy(baseConfig);

      // GitHub refuses a token request this way, with a 200.
      const mockResponse = new Response(
        "error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.&error_uri=https%3A%2F%2Fdocs.github.com",
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          status: 200,
        },
      );

      const err = await (proxy as any)
        .parseTokenResponse(mockResponse)
        .catch((e: any) => e);

      expect(err.name).toBe("OAuthProxyError");
      expect(err.code).toBe("bad_verification_code");
      expect(err.description).toBe("The code passed is incorrect or expired.");

      proxy.destroy();
    });

    it("should throw the error a JSON 200 response reports, with no description", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({ error: "invalid_client" }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      const err = await (proxy as any)
        .parseTokenResponse(mockResponse)
        .catch((e: any) => e);

      expect(err.name).toBe("OAuthProxyError");
      expect(err.code).toBe("invalid_client");
      expect(err.description).toBeUndefined();

      proxy.destroy();
    });

    it("should read a token whose response carries a null error", async () => {
      const proxy = new OAuthProxy(baseConfig);

      const mockResponse = new Response(
        JSON.stringify({ access_token: "token", error: null }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );

      const tokens = await (proxy as any).parseTokenResponse(mockResponse);

      expect(tokens.access_token).toBe("token");

      proxy.destroy();
    });
  });

  describe("upstream error response handling", () => {
    it("should pass on the error a provider reports with a 200 when exchanging the code", async () => {
      const proxy = new OAuthProxy({
        ...baseConfig,
        enableTokenSwap: false,
      });

      const callback = await upstreamCallback(proxy);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          "error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.",
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            status: 200,
          },
        );

      try {
        const err = await proxy.handleCallback(callback).catch((e: any) => e);

        expect(err.name).toBe("OAuthProxyError");
        expect(err.code).toBe("bad_verification_code");
        expect(err.description).toBe(
          "The code passed is incorrect or expired.",
        );
      } finally {
        globalThis.fetch = originalFetch;
        proxy.destroy();
      }
    });

    it("should pass on the error a provider reports with a 200 when refreshing", async () => {
      const proxy = new OAuthProxy({
        ...baseConfig,
        enableTokenSwap: false,
      });

      const request = await issuePassthroughRefreshRequest(
        proxy,
        "revoked-token",
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          "error=bad_refresh_token&error_description=The+refresh+token+passed+is+incorrect+or+expired.",
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            status: 200,
          },
        );

      try {
        const err = await proxy
          .exchangeRefreshToken(request)
          .catch((e: any) => e);

        expect(err.name).toBe("OAuthProxyError");
        expect(err.code).toBe("bad_refresh_token");
        expect(err.description).toBe(
          "The refresh token passed is incorrect or expired.",
        );
      } finally {
        globalThis.fetch = originalFetch;
        proxy.destroy();
      }
    });

    it("should handle non-JSON error from upstream token endpoint without crashing", async () => {
      // Disable token swap so exchangeRefreshToken goes through handlePassthroughRefresh
      const proxy = new OAuthProxy({
        ...baseConfig,
        enableTokenSwap: false,
      });

      const request = await issuePassthroughRefreshRequest(
        proxy,
        "test-refresh-token",
      );

      // Mock global fetch to return an HTML error page (e.g. load balancer 502)
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          headers: { "Content-Type": "text/html" },
          status: 502,
          statusText: "Bad Gateway",
        });

      try {
        // For HTTP-level errors (non-OAuth), description contains the HTTP status.
        const err = await proxy
          .exchangeRefreshToken(request)
          .catch((e: any) => e);

        expect(err.name).toBe("OAuthProxyError");
        expect(err.description).toMatch(/Upstream returned HTTP 502/);
      } finally {
        globalThis.fetch = originalFetch;
        proxy.destroy();
      }
    });

    it("should still parse JSON error bodies from upstream when available", async () => {
      const proxy = new OAuthProxy({
        ...baseConfig,
        enableTokenSwap: false,
      });

      const request = await issuePassthroughRefreshRequest(
        proxy,
        "expired-token",
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Refresh token expired",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 400,
            statusText: "Bad Request",
          },
        );

      try {
        const err = await proxy
          .exchangeRefreshToken(request)
          .catch((e: any) => e);

        expect(err.name).toBe("OAuthProxyError");
        expect(err.code).toBe("invalid_grant");
        expect(err.description).toBe("Refresh token expired");
      } finally {
        globalThis.fetch = originalFetch;
        proxy.destroy();
      }
    });
  });
});
