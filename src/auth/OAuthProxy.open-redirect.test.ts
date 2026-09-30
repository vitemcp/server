/**
 * Regression tests for CWE-601 open-redirect / authorization-code theft in
 * OAuthProxy. See the SECURITY advisory for the full threat model.
 *
 * The pre-patch behaviour was:
 *   - `authorize()` stored `redirect_uri` verbatim, with no allow-list check.
 *   - `handleCallback()` then 302-redirected the fresh authorization code to
 *     that attacker-controlled URL.
 *   - `validateRedirectUri()` existed but was only called from DCR, and its
 *     default patterns (`["https://*", "http://localhost:*"]`) matched
 *     `https://evil.attacker.com/*` anyway.
 *   - `registeredClients` was written by DCR but never read.
 *
 * These tests verify that the patched behaviour closes all four gaps.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthorizationParams,
  TokenStorage,
  UpstreamTokenSet,
} from "./types.js";

import { OAuthProxy, OAuthProxyError } from "./OAuthProxy.js";
import { issuerNamespace } from "./OAuthProxyStateStore.js";

/**
 * Proxy state lives in the TokenStorage, so tests that need to tamper with a
 * stored transaction reach in through this rather than through proxy
 * internals. Values are held as-is (the proxy is configured with
 * `encryptionKey: false`) so a test can read a record, modify it, and put it
 * back the way a compromised backend would.
 */
class InspectableTokenStorage implements TokenStorage {
  private store = new Map<string, unknown>();

  async cleanup(): Promise<void> {}

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async get(key: string): Promise<null | unknown> {
    return this.store.get(key) ?? null;
  }

  keys(prefix: string): string[] {
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }

  async save(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async take(key: string): Promise<null | unknown> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
}

/** Records are namespaced by the upstream issuer (SEP-2352). */
const TRANSACTION_PREFIX = `transaction:${issuerNamespace("https://provider.com")}:`;

const baseConfig = {
  allowedRedirectUriPatterns: ["https://client.example.com/*"],
  baseUrl: "http://localhost:4200",
  consentRequired: false,
  redirectPath: "/oauth/callback",
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: "legit-upstream-id",
  upstreamClientSecret: "legit-upstream-secret",
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
};

const LEGIT_REDIRECT = "https://client.example.com/callback";
const EVIL_REDIRECT = "http://evil.attacker.com/steal";

/**
 * Drives the allow-list through DCR, which is the reachable path to
 * validateRedirectUri(). `patterns` omitted exercises the loopback default.
 */
const register = async (patterns: string[] | undefined, uri: string) => {
  const scoped = new OAuthProxy({
    ...baseConfig,
    // Passing undefined is meaningful: it overrides baseConfig's pattern and
    // exercises the loopback default.
    allowedRedirectUriPatterns: patterns,
  });

  try {
    return await scoped.registerClient({ redirect_uris: [uri] });
  } finally {
    scoped.destroy();
  }
};

const expectAllowed = (patterns: string[] | undefined, uri: string) =>
  expect(register(patterns, uri)).resolves.toBeDefined();

const expectRejected = (patterns: string[] | undefined, uri: string) =>
  expect(register(patterns, uri)).rejects.toMatchObject({
    code: "invalid_redirect_uri",
  });

function buildAuthParams(
  overrides: Partial<AuthorizationParams> = {},
): AuthorizationParams {
  return {
    client_id: baseConfig.upstreamClientId,
    redirect_uri: LEGIT_REDIRECT,
    response_type: "code",
    state: "victim-state",
    ...overrides,
  } as AuthorizationParams;
}

function mockUpstreamTokenEndpoint() {
  const upstream: UpstreamTokenSet = {
    accessToken: "UP_ACCESS_TOKEN",
    expiresIn: 3600,
    issuedAt: new Date(),
    refreshToken: "UP_REFRESH_TOKEN",
    scope: ["read"],
    tokenType: "Bearer",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: upstream.accessToken,
            expires_in: upstream.expiresIn,
            refresh_token: upstream.refreshToken,
            scope: upstream.scope.join(" "),
            token_type: upstream.tokenType,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
    ),
  );
}

describe("OAuthProxy CWE-601 open-redirect regression", () => {
  let proxy: OAuthProxy;
  let storage: InspectableTokenStorage;

  beforeEach(() => {
    storage = new InspectableTokenStorage();
    proxy = new OAuthProxy({
      ...baseConfig,
      encryptionKey: false,
      tokenStorage: storage,
    });
  });

  describe("authorize() rejects unregistered redirect_uri", () => {
    it("rejects an arbitrary attacker host even when client_id is valid", async () => {
      const dcr = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });

      await expect(
        proxy.authorize(
          buildAuthParams({
            client_id: dcr.client_id,
            redirect_uri: EVIL_REDIRECT,
          }),
        ),
      ).rejects.toMatchObject({
        code: "invalid_request",
        description: expect.stringContaining("redirect_uri"),
      });
    });

    it("rejects redirect_uri before any client has been registered", async () => {
      // No DCR call at all — registeredClientsByClientId is empty, so we get
      // invalid_client (unknown client_id) rather than invalid_request.
      await expect(
        proxy.authorize(buildAuthParams({ redirect_uri: LEGIT_REDIRECT })),
      ).rejects.toMatchObject({ code: "invalid_client" });
    });

    it("rejects a URI that only differs by trailing slash (exact match required)", async () => {
      const dcr = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });

      await expect(
        proxy.authorize(
          buildAuthParams({
            client_id: dcr.client_id,
            redirect_uri: LEGIT_REDIRECT + "/",
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("rejects a URI whose host only differs in casing (strict string compare)", async () => {
      const dcr = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });

      await expect(
        proxy.authorize(
          buildAuthParams({
            client_id: dcr.client_id,
            redirect_uri: "https://CLIENT.example.com/callback",
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });
  });

  describe("authorize() rejects unknown client_id", () => {
    it("rejects any client_id that was not issued by this proxy", async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      await expect(
        proxy.authorize(
          buildAuthParams({ client_id: "arbitrary-attacker-id" }),
        ),
      ).rejects.toMatchObject({
        code: "invalid_client",
      });
    });
  });

  describe("PoC reproducer — end-to-end, pre-patch behaviour must be blocked", () => {
    it("the original PoC link no longer leaks a code to evil.attacker.com", async () => {
      // Reproduces the published PoC verbatim: no DCR, arbitrary client_id,
      // attacker redirect_uri. The pre-patch flow would 302 a fresh code to
      // http://evil.attacker.com/steal?code=...; the patched flow must throw.
      mockUpstreamTokenEndpoint();

      await expect(
        proxy.authorize({
          client_id: "arbitrary-client-id",
          redirect_uri: EVIL_REDIRECT,
          response_type: "code",
          state: "victim-state",
        } as AuthorizationParams),
      ).rejects.toBeInstanceOf(OAuthProxyError);

      // And no transaction should have been persisted.
      expect(storage.keys(TRANSACTION_PREFIX)).toHaveLength(0);
    });

    it("an attacker cannot self-register a non-localhost URI with the default config", async () => {
      // When allowedRedirectUriPatterns is omitted (undefined), the proxy
      // defaults to localhost-only.  An attacker who controls evil.attacker.com
      // or a non-localhost https URI cannot self-register through DCR.
      const defaultProxy = new OAuthProxy({
        ...baseConfig,
        allowedRedirectUriPatterns: undefined,
      });

      await expect(
        defaultProxy.registerClient({ redirect_uris: [EVIL_REDIRECT] }),
      ).rejects.toMatchObject({ code: "invalid_redirect_uri" });

      // Non-localhost https URI is also rejected under the default.
      await expect(
        defaultProxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] }),
      ).rejects.toMatchObject({ code: "invalid_redirect_uri" });

      // A localhost URI IS accepted (needed for MCP clients with dynamic ports).
      await expect(
        defaultProxy.registerClient({
          redirect_uris: ["http://localhost:54321/callback"],
        }),
      ).resolves.toBeDefined();

      defaultProxy.destroy();
    });
  });

  describe("handleCallback() defense-in-depth", () => {
    it("refuses to 302 if the stored clientCallbackUrl is no longer registered", async () => {
      const dcr = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });
      mockUpstreamTokenEndpoint();

      // Start a legitimate transaction.
      const authResp = await proxy.authorize(
        buildAuthParams({ client_id: dcr.client_id }),
      );
      expect(authResp.status).toBe(302);
      const upstreamUrl = new URL(authResp.headers.get("Location")!);
      const transactionId = upstreamUrl.searchParams.get("state")!;

      // Simulate revocation / tampering: drop the URI from the registry and
      // hand-craft an attacker replacement inside the transaction record.
      const transactionKey = `${TRANSACTION_PREFIX}${transactionId}`;
      const txn = (await storage.get(transactionKey)) as {
        clientCallbackUrl: string;
      };
      txn.clientCallbackUrl = EVIL_REDIRECT;
      await storage.save(transactionKey, txn);

      const cbReq = new Request(
        `${baseConfig.baseUrl}${baseConfig.redirectPath}?code=UP_CODE&state=${encodeURIComponent(
          transactionId,
        )}`,
      );

      await expect(proxy.handleCallback(cbReq)).rejects.toMatchObject({
        code: "invalid_request",
      });

      // Transaction should be purged so an attacker can't replay it.
      expect(await storage.get(transactionKey)).toBeNull();
    });
  });

  describe("handleConsent() deny branch defense-in-depth", () => {
    it("refuses to 302 to a tampered clientCallbackUrl on deny", async () => {
      const consentStorage = new InspectableTokenStorage();
      const consentProxy = new OAuthProxy({
        ...baseConfig,
        consentRequired: true,
        encryptionKey: false,
        tokenStorage: consentStorage,
      });
      const dcr = await consentProxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });

      const authResp = await consentProxy.authorize(
        buildAuthParams({ client_id: dcr.client_id }),
      );
      // Consent HTML response is a 200, not a 302.
      expect(authResp.status).toBe(200);

      const [transactionKey] = consentStorage.keys(TRANSACTION_PREFIX);
      const transactionId = transactionKey.slice(TRANSACTION_PREFIX.length);
      const txn = (await consentStorage.get(transactionKey)) as {
        clientCallbackUrl: string;
      };
      txn.clientCallbackUrl = EVIL_REDIRECT;
      await consentStorage.save(transactionKey, txn);

      const formBody = new URLSearchParams({
        action: "deny",
        transaction_id: transactionId,
      }).toString();
      const denyReq = new Request("http://localhost:4200/oauth/consent", {
        body: formBody,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      await expect(consentProxy.handleConsent(denyReq)).rejects.toMatchObject({
        code: "invalid_request",
      });

      consentProxy.destroy();
    });
  });

  describe("exchangeAuthorizationCode() rejects unknown client_id", () => {
    it("rejects a token exchange with an unregistered client_id", async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      await expect(
        proxy.exchangeAuthorizationCode({
          client_id: "not-the-upstream-client-id",
          code: "irrelevant",
          grant_type: "authorization_code",
          redirect_uri: LEGIT_REDIRECT,
        }),
      ).rejects.toMatchObject({ code: "invalid_client" });
    });
  });

  describe("happy path still works for registered clients", () => {
    it("a properly-registered client completes the full authorize -> callback flow", async () => {
      const dcr = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });
      mockUpstreamTokenEndpoint();

      const authResp = await proxy.authorize(
        buildAuthParams({ client_id: dcr.client_id }),
      );
      expect(authResp.status).toBe(302);
      const upstreamUrl = new URL(authResp.headers.get("Location")!);
      expect(upstreamUrl.origin + upstreamUrl.pathname).toBe(
        baseConfig.upstreamAuthorizationEndpoint,
      );
      const transactionId = upstreamUrl.searchParams.get("state")!;

      const cbReq = new Request(
        `${baseConfig.baseUrl}${baseConfig.redirectPath}?code=UP_CODE&state=${encodeURIComponent(
          transactionId,
        )}`,
      );
      const cbResp = await proxy.handleCallback(cbReq);

      expect(cbResp.status).toBe(302);
      const finalLocation = new URL(cbResp.headers.get("Location")!);
      expect(finalLocation.origin + finalLocation.pathname).toBe(
        LEGIT_REDIRECT,
      );
      expect(finalLocation.searchParams.get("code")).toBeTruthy();
      expect(finalLocation.searchParams.get("state")).toBe("victim-state");
    });

    it("DCR stores every URI in the array, not just the first", async () => {
      const multi = new OAuthProxy({
        ...baseConfig,
        allowedRedirectUriPatterns: ["https://client.example.com/*"],
      });
      const dcr = await multi.registerClient({
        redirect_uris: [
          "https://client.example.com/a",
          "https://client.example.com/b",
        ],
      });

      await expect(
        multi.authorize(
          buildAuthParams({
            client_id: dcr.client_id,
            redirect_uri: "https://client.example.com/b",
          }),
        ),
      ).resolves.toBeDefined();

      multi.destroy();
    });
  });

  describe("validateRedirectUri() has no permissive fallback", () => {
    it("rejects https://evil.attacker.com with empty patterns", async () => {
      const strict = new OAuthProxy({
        ...baseConfig,
        allowedRedirectUriPatterns: [],
      });
      await expect(
        strict.registerClient({
          redirect_uris: ["https://evil.attacker.com/steal"],
        }),
      ).rejects.toMatchObject({ code: "invalid_redirect_uri" });
      strict.destroy();
    });

    it("rejects http://localhost:9999 with empty patterns", async () => {
      const strict = new OAuthProxy({
        ...baseConfig,
        allowedRedirectUriPatterns: [],
      });
      await expect(
        strict.registerClient({
          redirect_uris: ["http://localhost:9999/cb"],
        }),
      ).rejects.toMatchObject({ code: "invalid_redirect_uri" });
      strict.destroy();
    });

    it("accepts URIs that explicitly match a configured pattern", async () => {
      const loose = new OAuthProxy({
        ...baseConfig,
        allowedRedirectUriPatterns: ["http://localhost:*/cb"],
      });
      await expect(
        loose.registerClient({
          redirect_uris: ["http://localhost:9999/cb"],
        }),
      ).resolves.toBeDefined();
      loose.destroy();
    });
  });

  /**
   * A pattern is a glob, not a regex. Compiling one into a RegExp without
   * escaping made every metacharacter in it live, which widens the allow-list
   * past the single host the operator wrote and hands DCR back to an attacker.
   * Asserted through registerClient(), since that is the reachable path.
   */
  describe("validateRedirectUri() treats patterns as globs, not regexes", () => {
    it("does not let a `.` in the pattern match an arbitrary character", async () => {
      // The operator wrote one host; a lookalike an attacker can register
      // must not satisfy it.
      await expectRejected(
        ["https://client.example.com/*"],
        "https://clientXexampleYcom/steal",
      );
    });

    it("does not treat a `+` in the pattern as a quantifier", async () => {
      // Only the `+` differs here: as a quantifier it would let one `a` in the
      // pattern stand for the run of them in the host.
      await expectRejected(
        ["https://a+b.example.com/cb"],
        "https://aaab.example.com/cb",
      );
    });

    it("does not let a `|` in the pattern become an alternation", async () => {
      // Unescaped, `|` splits the whole expression at the top level, so the
      // right-hand branch alone satisfies the allow-list.
      await expectRejected(
        ["https://client.example.com/cb|https://evil.attacker.com"],
        "https://evil.attacker.com",
      );
    });

    it("matches a literal metacharacter that is really in the URI", async () => {
      // Narrowing must not break patterns that were already correct: an
      // escaped character has to match itself. As a quantifier `a+` would
      // never match the literal `a+` below.
      await expectAllowed(
        ["https://client.example.com/a+b"],
        "https://client.example.com/a+b",
      );
    });

    it("keeps `*` and `?` working as wildcards", async () => {
      await expectAllowed(
        ["https://client.example.com/*"],
        "https://client.example.com/deep/callback",
      );

      await expectAllowed(
        ["https://client.example.com/cb?"],
        "https://client.example.com/cbX",
      );
    });
  });

  /**
   * A pattern used to be matched against the raw URI string, so a wildcard ran
   * straight through the delimiters that decide where the browser navigates.
   * Matching component-by-component against URL's parse contains it.
   */
  describe("validateRedirectUri() matches per URI component", () => {
    it("rejects a userinfo host that only reads as the allowed one", async () => {
      // `localhost:` here is userinfo; the host is evil.com. The old matcher
      // saw a string starting with "http://localhost:" and allowed it.
      await expectRejected(undefined, "http://localhost:@evil.com/cb");
      await expectRejected(
        ["http://localhost:*"],
        "http://localhost:@evil.com/cb",
      );
    });

    it("rejects userinfo even on a host the pattern does allow", async () => {
      // Every component here satisfies the pattern — host included — so only
      // the userinfo rule can reject it. Nothing legitimate puts credentials
      // in a redirect URI.
      await expectRejected(
        ["https://*.example.com/*"],
        "https://user:pw@app.example.com/cb",
      );
    });

    it("does not let a host wildcard reach into the path", async () => {
      // `*` in `https://*.example.com/*` used to cover "evil.com/a", spanning
      // authority and path at once.
      await expectRejected(
        ["https://*.example.com/*"],
        "https://evil.com/a.example.com/cb",
      );

      await expectRejected(
        ["https://*.example.com/*"],
        "https://evil.com:8443/x.example.com/cb",
      );
    });

    it("pins the scheme and the port", async () => {
      await expectRejected(
        ["https://app.example.com/*"],
        "http://app.example.com/cb",
      );

      await expectRejected(
        ["https://app.example.com:8443/*"],
        "https://app.example.com:9999/cb",
      );
    });

    it("refuses an authority the pattern never granted", async () => {
      // `com.example.app:/*` names no authority, so a URI that carries one
      // must not satisfy it.
      await expectRejected(
        ["com.example.app:/*"],
        "com.example.app://evil.com/cb",
      );
    });

    it("still accepts every documented pattern shape", async () => {
      // The three forms in docs/oauth.md, plus the loopback default.
      await expectAllowed(
        ["https://*.example.com/*"],
        "https://app.example.com/callback",
      );
      await expectAllowed(["http://localhost:*"], "http://localhost:1234/cb");
      await expectAllowed(
        ["https://app.example.com/callback"],
        "https://app.example.com/callback",
      );
      await expectAllowed(undefined, "http://127.0.0.1:33418/callback");
    });

    it("keeps a path-less pattern scoped to scheme, host and port", async () => {
      // An ephemeral loopback client picks its own callback path, so a pattern
      // that omits the path constrains the authority only — but only there.
      await expectAllowed(undefined, "http://localhost:8080/any/path");
      await expectRejected(
        ["https://app.example.com/callback"],
        "https://app.example.com/other",
      );
    });

    it("compares hosts case-insensitively and normalizes a default port", async () => {
      // Both are the same origin, and URL says so; the old string compare did
      // not.
      await expectAllowed(
        ["https://client.example.com/*"],
        "https://CLIENT.Example.COM/cb",
      );
      await expectAllowed(
        ["https://app.example.com/*"],
        "https://app.example.com:443/cb",
      );
    });

    it("supports private-use schemes and IPv6 literals", async () => {
      // RFC 8252 §7.1 native-app callbacks, and the bracketed loopback whose
      // colons must not be read as a port separator.
      await expectAllowed(
        ["com.example.app:/*"],
        "com.example.app:/oauth2redirect",
      );
      await expectAllowed(["myapp://callback"], "myapp://callback");
      await expectAllowed(["http://[::1]:*"], "http://[::1]:9999/cb");
    });
  });

  describe("a CIMD client_id faces the same allow-list as DCR", () => {
    /**
     * A URL-formatted `client_id` is resolved by fetching a document from that
     * URL, which the client's own operator writes. The redirect URIs it
     * declares are therefore exactly as trustworthy as the ones a DCR request
     * carries, and have to clear the same allow-list — otherwise anyone able to
     * host an HTTPS file could name their own callback and be handed the code,
     * with `allowedRedirectUriPatterns` never consulted.
     *
     * The fetch itself is stubbed: the network path and its SSRF defences are
     * covered in `clientIdMetadata.test.ts`, and what is under test here is
     * what the proxy does with a document it has already accepted.
     */
    const proxyServingDocument = (redirectUris: string[]) => {
      const proxy = new OAuthProxy(baseConfig);

      (
        proxy as unknown as {
          clientIdMetadata: {
            resolve: (clientId: string) => Promise<unknown>;
          };
        }
      ).clientIdMetadata.resolve = async (clientId: string) => ({
        client_id: clientId,
        client_name: "Test Client",
        redirect_uris: redirectUris,
      });

      return proxy;
    };

    const CIMD_CLIENT_ID = "https://client.example.com/client.json";

    it("refuses a document declaring an off-allow-list redirect URI", async () => {
      // The same URI DCR rejects outright, arriving by the other door.
      await expectRejected(
        baseConfig.allowedRedirectUriPatterns,
        EVIL_REDIRECT,
      );

      const proxy = proxyServingDocument([EVIL_REDIRECT]);

      await expect(
        proxy.authorize(
          buildAuthParams({
            client_id: CIMD_CLIENT_ID,
            redirect_uri: EVIL_REDIRECT,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_client" });

      proxy.destroy();
    });

    it("refuses the whole client when any declared URI is off the allow-list", async () => {
      // Registering under a good URI and then using the smuggled one must not
      // be possible, so one bad entry disqualifies the document.
      const proxy = proxyServingDocument([LEGIT_REDIRECT, EVIL_REDIRECT]);

      await expect(
        proxy.authorize(
          buildAuthParams({
            client_id: CIMD_CLIENT_ID,
            redirect_uri: LEGIT_REDIRECT,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_client" });

      proxy.destroy();
    });

    it("still admits a document whose URIs all match the allow-list", async () => {
      const proxy = proxyServingDocument([LEGIT_REDIRECT]);

      const response = await proxy.authorize(
        buildAuthParams({
          client_id: CIMD_CLIENT_ID,
          // A CIMD client is a public client, and is held to S256 PKCE.
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
          redirect_uri: LEGIT_REDIRECT,
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        baseConfig.upstreamAuthorizationEndpoint,
      );

      proxy.destroy();
    });
  });
});
