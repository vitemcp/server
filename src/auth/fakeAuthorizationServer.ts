import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A real OAuth 2.1 authorization server, for tests.
 *
 * The rest of the auth suite stubs `fetch`, which means the proxy's upstream
 * leg is never actually exercised: no real HTTP, no real redirects, no real
 * form encoding, and — most importantly — nothing on the other end that
 * *verifies* what the proxy sent. A stub that returns a token no matter what
 * cannot tell you the proxy computed its PKCE verifier correctly.
 *
 * This server does verify. It checks PKCE, enforces single-use authorization
 * codes, rotates refresh tokens, and returns `iss` on the authorization
 * response, so a proxy that gets any of that wrong fails here.
 *
 * It is not Google or GitHub — provider-specific quirks are out of scope — but
 * it is a conforming counterparty, which is what the mocks were missing.
 */

export interface FakeAuthorizationServer {
  authorizationEndpoint: string;
  /** Requests the server received, for assertions. */
  readonly authorizeRequests: URLSearchParams[];
  close: () => Promise<void>;
  issuer: string;
  /** Refresh tokens the server has issued, newest last. */
  readonly refreshTokens: string[];
  tokenEndpoint: string;
  readonly tokenRequests: URLSearchParams[];
}

export interface FakeAuthorizationServerOptions {
  /** Serve token responses as `application/x-www-form-urlencoded` (the GitHub Apps shape). */
  formEncodedTokens?: boolean;
  /** Omit `iss` from the authorization response (a pre-RFC-9207 provider). */
  omitIss?: boolean;
  /** Return this issuer in `iss` instead of the server's own (simulates a mix-up attack). */
  spoofIssuer?: string;
}

interface IssuedCode {
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
  used: boolean;
}

const verifyPkce = (verifier: string, challenge: string, method: string) => {
  if (method === "plain") {
    return verifier === challenge;
  }

  return (
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
};

export const startFakeAuthorizationServer = async (
  options: FakeAuthorizationServerOptions = {},
): Promise<FakeAuthorizationServer> => {
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Set<string>();
  const authorizeRequests: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const issuedRefreshTokens: string[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const issuer = `http://${req.headers.host}`;

      if (url.pathname === "/authorize") {
        authorizeRequests.push(url.searchParams);

        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");

        if (!redirectUri) {
          res.writeHead(400).end("missing redirect_uri");
          return;
        }

        // Issue a code bound to the PKCE challenge, so the token exchange can
        // prove the caller is the same party that started the flow.
        const code = randomBytes(16).toString("hex");
        codes.set(code, {
          codeChallenge: url.searchParams.get("code_challenge") ?? "",
          codeChallengeMethod:
            url.searchParams.get("code_challenge_method") ?? "plain",
          redirectUri,
          scope: url.searchParams.get("scope") ?? "",
          used: false,
        });

        const location = new URL(redirectUri);
        location.searchParams.set("code", code);

        if (state) {
          location.searchParams.set("state", state);
        }

        // RFC 9207: identify the issuer so the client can detect a mix-up.
        if (!options.omitIss) {
          location.searchParams.set("iss", options.spoofIssuer ?? issuer);
        }

        res.writeHead(302, { Location: location.toString() }).end();
        return;
      }

      if (url.pathname === "/token") {
        const chunks: Buffer[] = [];

        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const params = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        tokenRequests.push(params);

        const fail = (error: string, description?: string) =>
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error, error_description: description }));

        // Client credentials may arrive in the body or via Basic auth.
        const authHeader = req.headers.authorization;
        const hasCredentials =
          Boolean(params.get("client_id")) ||
          Boolean(authHeader?.toLowerCase().startsWith("basic "));

        if (!hasCredentials) {
          fail("invalid_client", "no client credentials");
          return;
        }

        const grantType = params.get("grant_type");

        if (grantType === "refresh_token") {
          const presented = params.get("refresh_token") ?? "";

          if (!refreshTokens.has(presented)) {
            fail("invalid_grant", "unknown or already-used refresh token");
            return;
          }

          // Single-use rotation: the presented token dies here.
          refreshTokens.delete(presented);
        } else if (grantType === "authorization_code") {
          const code = params.get("code") ?? "";
          const issued = codes.get(code);

          if (!issued || issued.used) {
            fail("invalid_grant", "unknown or already-used code");
            return;
          }

          issued.used = true;

          if (params.get("redirect_uri") !== issued.redirectUri) {
            fail("invalid_grant", "redirect_uri mismatch");
            return;
          }

          // The whole point of PKCE: a stolen code is useless without the
          // verifier. A stubbed provider never checks this.
          if (
            issued.codeChallenge &&
            !verifyPkce(
              params.get("code_verifier") ?? "",
              issued.codeChallenge,
              issued.codeChallengeMethod,
            )
          ) {
            fail("invalid_grant", "PKCE verification failed");
            return;
          }
        } else {
          fail("unsupported_grant_type", grantType ?? "(none)");
          return;
        }

        const refreshToken = `refresh-${randomBytes(8).toString("hex")}`;
        refreshTokens.add(refreshToken);
        issuedRefreshTokens.push(refreshToken);

        const payload = {
          access_token: `access-${randomBytes(8).toString("hex")}`,
          expires_in: 3600,
          refresh_token: refreshToken,
          scope: "read write",
          token_type: "Bearer",
        };

        if (options.formEncodedTokens) {
          // GitHub Apps answer form-encoded rather than JSON.
          res
            .writeHead(200, {
              "Content-Type": "application/x-www-form-urlencoded",
            })
            .end(new URLSearchParams(payload as never).toString());
          return;
        }

        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404).end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const issuer = `http://127.0.0.1:${port}`;

  return {
    authorizationEndpoint: `${issuer}/authorize`,
    authorizeRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    issuer,
    refreshTokens: issuedRefreshTokens,
    tokenEndpoint: `${issuer}/token`,
    tokenRequests,
  };
};
