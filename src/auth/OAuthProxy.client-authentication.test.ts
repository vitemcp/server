/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FakeAuthorizationServer } from "./fakeAuthorizationServer.js";
import type { DCRResponse, OAuthProxyConfig } from "./types.js";

import { startFakeAuthorizationServer } from "./fakeAuthorizationServer.js";
import { OAuthProxy } from "./OAuthProxy.js";
import { issuerNamespace } from "./OAuthProxyStateStore.js";
import { createOAuthRouter } from "./router.js";
import { JWTIssuer } from "./utils/jwtIssuer.js";
import { PKCEUtils } from "./utils/pkce.js";
import { MemoryTokenStorage } from "./utils/tokenStore.js";

/**
 * Client authentication at the token endpoint, and the binding of every grant
 * to the client it was issued to.
 *
 * Before this, the proxy issued each DCR client a secret and never checked it:
 * a wrong secret, or none at all, redeemed codes and refresh tokens alike. A
 * refresh token was not tied to any client, an access token could be redeemed
 * as a refresh token, and passthrough mode forwarded any upstream refresh
 * token with the proxy's own upstream credentials attached.
 *
 * Driven through the HTTP routes, against a real authorization server, so the
 * status codes and headers are the ones a client sees.
 */

const BASE = "http://localhost:4200";
const CALLBACK = "https://client.example.com/callback";
const SIGNING_KEY = "client-authentication-test-signing-key";

const basic = (clientId: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;

const decodePayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

describe("OAuthProxy client authentication", () => {
  let upstream: FakeAuthorizationServer;
  const proxies: OAuthProxy[] = [];

  beforeEach(async () => {
    upstream = await startFakeAuthorizationServer();
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      proxy.destroy();
    }

    await upstream.close();
  });

  const makeProxy = (overrides: Partial<OAuthProxyConfig> = {}) => {
    const proxy = new OAuthProxy({
      allowedRedirectUriPatterns: ["https://client.example.com/*"],
      baseUrl: BASE,
      consentRequired: false,
      jwtSigningKey: SIGNING_KEY,
      upstreamAuthorizationEndpoint: upstream.authorizationEndpoint,
      upstreamClientId: "proxy-client-id",
      upstreamClientSecret: "proxy-client-secret",
      upstreamIssuer: upstream.issuer,
      upstreamTokenEndpoint: upstream.tokenEndpoint,
      ...overrides,
    });

    proxies.push(proxy);

    return proxy;
  };

  /** A proxy's HTTP routes, the way a client reaches them. */
  const serve = (proxy: OAuthProxy) => {
    const app = createOAuthRouter({ proxy });

    const register = async (metadata: Record<string, unknown> = {}) => {
      const response = await app.fetch(
        new Request(`${BASE}/oauth/register`, {
          body: JSON.stringify({ redirect_uris: [CALLBACK], ...metadata }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      return {
        body: (await response.json()) as { error?: string } & DCRResponse,
        response,
      };
    };

    const authorize = (query: Record<string, string>) =>
      app.fetch(
        new Request(`${BASE}/oauth/authorize?${new URLSearchParams(query)}`),
      );

    /** authorize -> upstream -> callback: the code the client is handed. */
    const authorizeCode = async (
      clientId: string,
      { pkce = true }: { pkce?: boolean } = {},
    ) => {
      const pair = PKCEUtils.generatePair("S256");
      const response = await authorize({
        client_id: clientId,
        redirect_uri: CALLBACK,
        response_type: "code",
        scope: "read",
        ...(pkce && {
          code_challenge: pair.challenge,
          code_challenge_method: "S256",
        }),
      });

      expect(response.status).toBe(302);

      const atUpstream = await fetch(response.headers.get("location")!, {
        redirect: "manual",
      });
      const callback = await app.fetch(
        new Request(atUpstream.headers.get("location")!),
      );
      const code = new URL(callback.headers.get("location")!).searchParams.get(
        "code",
      )!;

      return { code, verifier: pkce ? pair.verifier : undefined };
    };

    const token = async (
      params: Record<string, string | undefined>,
      authorization?: string,
    ) => {
      const body = new URLSearchParams();

      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          body.set(key, value);
        }
      }

      const response = await app.fetch(
        new Request(`${BASE}/oauth/token`, {
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(authorization && { authorization }),
          },
          method: "POST",
        }),
      );

      return {
        body: (await response.json()) as Record<string, string>,
        response,
      };
    };

    const redeem = (
      issued: { code: string; verifier?: string },
      credentials: { authorization?: string; body?: Record<string, string> },
    ) =>
      token(
        {
          code: issued.code,
          code_verifier: issued.verifier,
          grant_type: "authorization_code",
          redirect_uri: CALLBACK,
          ...credentials.body,
        },
        credentials.authorization,
      );

    const refresh = (
      refreshToken: string,
      credentials: { authorization?: string; body?: Record<string, string> },
    ) =>
      token(
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          ...credentials.body,
        },
        credentials.authorization,
      );

    return { authorize, authorizeCode, redeem, refresh, register, token };
  };

  const expectInvalidClient = (result: {
    body: Record<string, string>;
    response: Response;
  }) => {
    expect(result.response.status).toBe(401);
    expect(result.body.error).toBe("invalid_client");
    expect(result.response.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
  };

  const expectInvalidGrant = (result: {
    body: Record<string, string>;
    response: Response;
  }) => {
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  };

  describe("a confidential client", () => {
    it("redeems a code only with its own secret, by either secret method", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register();
      const asBasic = (secret: string) => ({
        authorization: basic(client.client_id, secret),
      });

      expectInvalidClient(
        await http.redeem(
          await http.authorizeCode(client.client_id),
          asBasic("wrong"),
        ),
      );
      expectInvalidClient(
        await http.redeem(await http.authorizeCode(client.client_id), {
          body: { client_id: client.client_id },
        }),
      );
      expectInvalidClient(
        await http.redeem(await http.authorizeCode(client.client_id), {
          body: { client_id: client.client_id, client_secret: "wrong" },
        }),
      );

      const viaBasic = await http.redeem(
        await http.authorizeCode(client.client_id),
        asBasic(client.client_secret!),
      );
      expect(viaBasic.response.status).toBe(200);
      expect(viaBasic.body.access_token).toBeTruthy();

      // Registered for client_secret_basic, but a client that sends the secret
      // in the body has still proved it holds it.
      const viaPost = await http.redeem(
        await http.authorizeCode(client.client_id),
        {
          body: {
            client_id: client.client_id,
            client_secret: client.client_secret!,
          },
        },
      );
      expect(viaPost.response.status).toBe(200);
    });

    it("cannot have a code redeemed without the secret even when it skipped PKCE", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register();
      const issued = await http.authorizeCode(client.client_id, {
        pkce: false,
      });

      // The code and the public client_id are all an interceptor holds.
      expectInvalidClient(
        await http.redeem(issued, { body: { client_id: client.client_id } }),
      );
    });

    it("keeps its code redeemable after a caller fails to authenticate", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register();
      const issued = await http.authorizeCode(client.client_id);

      expectInvalidClient(
        await http.redeem(issued, {
          authorization: basic(client.client_id, "wrong"),
        }),
      );

      const legitimate = await http.redeem(issued, {
        authorization: basic(client.client_id, client.client_secret!),
      });
      expect(legitimate.response.status).toBe(200);
    });

    it("cannot have its code redeemed by another client, and the code is spent", async () => {
      const http = serve(makeProxy());
      const { body: victim } = await http.register();
      const { body: attacker } = await http.register();
      const issued = await http.authorizeCode(victim.client_id);

      const stolen = await http.redeem(issued, {
        authorization: basic(attacker.client_id, attacker.client_secret!),
      });
      expectInvalidGrant(stolen);
      expect(stolen.body.error_description).toMatch(/another client/);

      // Presented by the wrong client, the code has leaked: it stays spent.
      expectInvalidGrant(
        await http.redeem(issued, {
          authorization: basic(victim.client_id, victim.client_secret!),
        }),
      );
    });

    it("refreshes only with its own secret, and a failed attempt does not spend the token", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register();
      const credentials = {
        authorization: basic(client.client_id, client.client_secret!),
      };
      const { body: tokens } = await http.redeem(
        await http.authorizeCode(client.client_id),
        credentials,
      );

      expectInvalidClient(
        await http.refresh(tokens.refresh_token, {
          authorization: basic(client.client_id, "wrong"),
        }),
      );
      expectInvalidClient(await http.refresh(tokens.refresh_token, {}));
      expectInvalidClient(
        await http.refresh(tokens.refresh_token, {
          body: { client_id: client.client_id },
        }),
      );

      const refreshed = await http.refresh(tokens.refresh_token, credentials);
      expect(refreshed.response.status).toBe(200);
      expect(refreshed.body.refresh_token).toBeTruthy();
    });

    it("cannot have its refresh token redeemed by another client, which does not spend it", async () => {
      const http = serve(makeProxy());
      const { body: victim } = await http.register();
      const { body: attacker } = await http.register();
      const victimCredentials = {
        authorization: basic(victim.client_id, victim.client_secret!),
      };
      const { body: tokens } = await http.redeem(
        await http.authorizeCode(victim.client_id),
        victimCredentials,
      );

      // Anyone can register a client, so a valid secret proves nothing about
      // whose token this is.
      const stolen = await http.refresh(tokens.refresh_token, {
        authorization: basic(attacker.client_id, attacker.client_secret!),
      });
      expectInvalidGrant(stolen);
      expect(stolen.body.error_description).toMatch(/another client/);

      const legitimate = await http.refresh(
        tokens.refresh_token,
        victimCredentials,
      );
      expect(legitimate.response.status).toBe(200);
    });

    it("keeps requiring its secret after the proxy instance that registered it is gone", async () => {
      // The auth method has to survive a round trip through storage, or every
      // client loaded by another instance would be treated as one that may
      // leave its secret out.
      const tokenStorage = new MemoryTokenStorage();
      const registrar = serve(
        makeProxy({ encryptionKey: false, tokenStorage }),
      );
      const { body: client } = await registrar.register();

      const other = serve(makeProxy({ encryptionKey: false, tokenStorage }));
      const issued = await other.authorizeCode(client.client_id);

      expectInvalidClient(
        await other.redeem(issued, { body: { client_id: client.client_id } }),
      );

      const redeemed = await other.redeem(issued, {
        authorization: basic(client.client_id, client.client_secret!),
      });
      expect(redeemed.response.status).toBe(200);

      tokenStorage.destroy();
    });
  });

  describe("access and refresh tokens", () => {
    const issueTokens = async () => {
      const proxy = makeProxy();
      const http = serve(proxy);
      const { body: client } = await http.register();
      const credentials = {
        authorization: basic(client.client_id, client.client_secret!),
      };
      const { body: tokens } = await http.redeem(
        await http.authorizeCode(client.client_id),
        credentials,
      );

      return { credentials, http, proxy, tokens };
    };

    it("will not redeem an access token as a refresh token", async () => {
      const { credentials, http, tokens } = await issueTokens();

      const result = await http.refresh(tokens.access_token, credentials);

      expectInvalidGrant(result);
      expect(result.body.error_description).toBe("Not a refresh token");
    });

    it("will not accept a refresh token as a bearer credential", async () => {
      const { proxy, tokens } = await issueTokens();

      expect(
        await proxy.loadUpstreamTokens(tokens.access_token),
      ).not.toBeNull();
      expect(await proxy.loadUpstreamTokens(tokens.refresh_token)).toBeNull();
    });

    it("refuses tokens issued before they were typed", async () => {
      const { credentials, http, proxy, tokens } = await issueTokens();
      const issuer = new JWTIssuer({
        audience: BASE,
        issuer: BASE,
        signingKey: SIGNING_KEY,
      });

      // Same jti, so the mapping exists: the missing type is the only defect.
      const untyped = (jwt: string) => {
        const claims = decodePayload(jwt);
        delete claims.token_use;
        return (issuer as any).signToken(claims) as string;
      };

      expectInvalidGrant(
        await http.refresh(untyped(tokens.refresh_token), credentials),
      );
      expect(
        await proxy.loadUpstreamTokens(untyped(tokens.access_token)),
      ).toBeNull();
    });

    it("cannot have the token type overridden by an upstream claim", () => {
      const issuer = new JWTIssuer({
        audience: BASE,
        issuer: BASE,
        signingKey: SIGNING_KEY,
      });

      const access = issuer.issueAccessToken("client", [], {
        token_use: "refresh",
      });

      expect(decodePayload(access).token_use).toBe("access");
    });
  });

  describe('a public client (token_endpoint_auth_method "none")', () => {
    it("is issued no secret", async () => {
      const http = serve(makeProxy());
      const { body: client, response } = await http.register({
        token_endpoint_auth_method: "none",
      });

      expect(response.status).toBe(201);
      expect(client.token_endpoint_auth_method).toBe("none");
      expect(client).not.toHaveProperty("client_secret");
      expect(client).not.toHaveProperty("client_secret_expires_at");
    });

    it("must use S256 PKCE at /oauth/authorize", async () => {
      const http = serve(makeProxy({ allowPlainPkce: true }));
      const { body: client } = await http.register({
        token_endpoint_auth_method: "none",
      });
      const base = {
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        response_type: "code",
      };

      const withoutPkce = await http.authorize(base);
      expect(withoutPkce.status).toBe(400);
      expect(await withoutPkce.json()).toMatchObject({
        error: "invalid_request",
      });

      const plain = await http.authorize({
        ...base,
        code_challenge: "a".repeat(43),
        code_challenge_method: "plain",
      });
      expect(plain.status).toBe(400);
    });

    it("redeems and refreshes with its client_id alone, bound to that client", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register({
        token_endpoint_auth_method: "none",
      });
      const { body: other } = await http.register({
        token_endpoint_auth_method: "none",
      });
      const identify = { body: { client_id: client.client_id } };

      const redeemed = await http.redeem(
        await http.authorizeCode(client.client_id),
        identify,
      );
      expect(redeemed.response.status).toBe(200);

      expectInvalidGrant(
        await http.refresh(redeemed.body.refresh_token, {
          body: { client_id: other.client_id },
        }),
      );

      const refreshed = await http.refresh(
        redeemed.body.refresh_token,
        identify,
      );
      expect(refreshed.response.status).toBe(200);
    });

    it("cannot authenticate with a secret it was never issued", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register({
        token_endpoint_auth_method: "none",
      });

      expectInvalidClient(
        await http.redeem(await http.authorizeCode(client.client_id), {
          authorization: basic(client.client_id, "made-up"),
        }),
      );
    });

    it("may send HTTP Basic with an empty secret to identify itself", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register({
        token_endpoint_auth_method: "none",
      });

      const redeemed = await http.redeem(
        await http.authorizeCode(client.client_id),
        { authorization: basic(client.client_id, "") },
      );

      expect(redeemed.response.status).toBe(200);
    });
  });

  describe("a registration that predates recorded auth methods", () => {
    /**
     * Registered before the proxy recorded the auth method: it was issued a
     * secret whatever it asked for, and nothing says whether it uses it.
     */
    const legacyClient = async () => {
      const tokenStorage = new MemoryTokenStorage();
      const registrar = serve(
        makeProxy({ encryptionKey: false, tokenStorage }),
      );
      const { body: client } = await registrar.register();

      const key = `client:${issuerNamespace(upstream.issuer)}:${client.client_id}`;
      const { tokenEndpointAuthMethod, ...record } = (await tokenStorage.get(
        key,
      )) as Record<string, unknown>;
      expect(tokenEndpointAuthMethod).toBe("client_secret_basic");
      await tokenStorage.save(key, record);

      // A fresh instance, so the registration is read back from storage.
      return {
        client,
        http: serve(makeProxy({ encryptionKey: false, tokenStorage })),
        tokenStorage,
      };
    };

    it("is authenticated by its secret when it sends one, PKCE or not", async () => {
      const { client, http, tokenStorage } = await legacyClient();

      expectInvalidClient(
        await http.redeem(await http.authorizeCode(client.client_id), {
          authorization: basic(client.client_id, "wrong"),
        }),
      );

      const redeemed = await http.redeem(
        await http.authorizeCode(client.client_id, { pkce: false }),
        { authorization: basic(client.client_id, client.client_secret!) },
      );
      expect(redeemed.response.status).toBe(200);

      tokenStorage.destroy();
    });

    it("may leave its secret out only for a code bound by S256 PKCE", async () => {
      const { client, http, tokenStorage } = await legacyClient();
      const identify = { body: { client_id: client.client_id } };

      const unbound = await http.redeem(
        await http.authorizeCode(client.client_id, { pkce: false }),
        identify,
      );
      expectInvalidGrant(unbound);
      expect(unbound.body.error_description).toMatch(/S256 PKCE is required/);

      const bound = await http.redeem(
        await http.authorizeCode(client.client_id),
        identify,
      );
      expect(bound.response.status).toBe(200);

      // Its tokens were issued without authentication, so refreshing them
      // needs none.
      const refreshed = await http.refresh(bound.body.refresh_token, identify);
      expect(refreshed.response.status).toBe(200);

      tokenStorage.destroy();
    });

    it("must keep authenticating to refresh tokens it obtained by authenticating", async () => {
      const { client, http, tokenStorage } = await legacyClient();
      const credentials = {
        authorization: basic(client.client_id, client.client_secret!),
      };
      const { body: tokens } = await http.redeem(
        await http.authorizeCode(client.client_id),
        credentials,
      );

      // Leaving the secret out would otherwise turn the token back into a
      // bearer credential.
      expectInvalidClient(
        await http.refresh(tokens.refresh_token, {
          body: { client_id: client.client_id },
        }),
      );

      // ...and the failed attempt handed the token back rather than spending it.
      const refreshed = await http.refresh(tokens.refresh_token, credentials);
      expect(refreshed.response.status).toBe(200);

      expectInvalidClient(
        await http.refresh(refreshed.body.refresh_token, {
          body: { client_id: client.client_id },
        }),
      );

      tokenStorage.destroy();
    });
  });

  describe("passthrough mode", () => {
    const passthrough = async () => {
      const http = serve(makeProxy({ enableTokenSwap: false }));
      const { body: client } = await http.register();
      const credentials = {
        authorization: basic(client.client_id, client.client_secret!),
      };
      const { body: tokens } = await http.redeem(
        await http.authorizeCode(client.client_id),
        credentials,
      );

      return { client, credentials, http, tokens };
    };

    it("forwards a refresh only for the client the upstream token went to", async () => {
      const { credentials, http, tokens } = await passthrough();
      const { body: attacker } = await http.register();
      const forwarded = () =>
        upstream.tokenRequests.filter(
          (request) => request.get("grant_type") === "refresh_token",
        ).length;

      expectInvalidClient(await http.refresh(tokens.refresh_token, {}));
      expectInvalidGrant(
        await http.refresh(tokens.refresh_token, {
          authorization: basic(attacker.client_id, attacker.client_secret!),
        }),
      );

      // Neither reached the upstream with the proxy's credentials attached.
      expect(forwarded()).toBe(0);

      const refreshed = await http.refresh(tokens.refresh_token, credentials);
      expect(refreshed.response.status).toBe(200);
      expect(forwarded()).toBe(1);
    });

    it("refuses an upstream refresh token it never handed out", async () => {
      const { credentials, http } = await passthrough();

      expectInvalidGrant(await http.refresh("never-issued", credentials));
      expect(upstream.tokenRequests.at(-1)?.get("grant_type")).toBe(
        "authorization_code",
      );
    });

    it("follows the upstream's rotation", async () => {
      const { credentials, http, tokens } = await passthrough();

      const rotated = await http.refresh(tokens.refresh_token, credentials);
      expect(rotated.body.refresh_token).toBeTruthy();
      expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token);

      // The replaced token is refused here, before the upstream sees it.
      const requestsBefore = upstream.tokenRequests.length;
      expectInvalidGrant(await http.refresh(tokens.refresh_token, credentials));
      expect(upstream.tokenRequests.length).toBe(requestsBefore);

      const next = await http.refresh(rotated.body.refresh_token, credentials);
      expect(next.response.status).toBe(200);
    });
  });

  describe("registration", () => {
    it("records and echoes the requested secret method", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register({
        token_endpoint_auth_method: "client_secret_post",
      });

      expect(client.token_endpoint_auth_method).toBe("client_secret_post");
      expect(client.client_secret).toBeTruthy();
      expect(client.client_secret_expires_at).toBe(0);
    });

    it("refuses an auth method the token endpoint cannot verify", async () => {
      const http = serve(makeProxy());
      const { body, response } = await http.register({
        token_endpoint_auth_method: "private_key_jwt",
      });

      expect(response.status).toBe(400);
      expect(body.error).toBe("invalid_client_metadata");
    });
  });

  describe("the token endpoint", () => {
    it("refuses credentials sent both in the header and in the body", async () => {
      const http = serve(makeProxy());
      const { body: client } = await http.register();
      const issued = await http.authorizeCode(client.client_id);

      const both = await http.redeem(issued, {
        authorization: basic(client.client_id, client.client_secret!),
        body: { client_secret: client.client_secret! },
      });
      expect(both.response.status).toBe(400);
      expect(both.body.error).toBe("invalid_request");

      const { body: other } = await http.register();
      const conflicting = await http.redeem(issued, {
        authorization: basic(client.client_id, client.client_secret!),
        body: { client_id: other.client_id },
      });
      expect(conflicting.response.status).toBe(400);
      expect(conflicting.body.error).toBe("invalid_request");

      // Neither touched the code.
      const redeemed = await http.redeem(issued, {
        authorization: basic(client.client_id, client.client_secret!),
        body: { client_id: client.client_id },
      });
      expect(redeemed.response.status).toBe(200);
    });

    it("answers a malformed Basic header with 401", async () => {
      const http = serve(makeProxy());

      expectInvalidClient(
        await http.token(
          { code: "x", grant_type: "authorization_code" },
          `Basic ${Buffer.from("no-separator").toString("base64")}`,
        ),
      );
      expectInvalidClient(
        await http.token(
          { code: "x", grant_type: "authorization_code" },
          `Basic ${Buffer.from("%E0%A4%A:secret").toString("base64")}`,
        ),
      );
    });

    it("answers an unknown client with 401", async () => {
      const http = serve(makeProxy());

      expectInvalidClient(
        await http.token(
          { code: "x", grant_type: "authorization_code" },
          basic("never-registered", "secret"),
        ),
      );
    });
  });
});
