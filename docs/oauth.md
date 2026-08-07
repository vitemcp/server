# OAuth

ViteMCP ships an OAuth 2.1 proxy that lets MCP clients authenticate against
providers which do not support Dynamic Client Registration. It presents a
DCR-compliant face to the client while using pre-registered credentials
upstream, and handles the whole authorization flow: PKCE, consent, token
exchange, refresh, and storage.

This is the complete OAuth reference. For the abbreviated version, see
[Authentication](../README.md#authentication) in the README.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Provider setup](#provider-setup)
- [Protecting tools](#protecting-tools)
- [Configuration](#configuration)
- [Token handling](#token-handling)
- [Storage](#storage)
- [Running multiple instances](#running-multiple-instances)
- [JWKS verification](#jwks-verification)
- [Client registration](#client-registration)
- [Security](#security)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Examples](#examples)
- [References](#references)

## How it works

```
1. Client → Proxy      DCR registration; proxy returns its own credentials
2. Client → Proxy      Authorization request with the client's PKCE challenge
3. Proxy  → User       Consent screen (prevents confused-deputy)
4. Proxy  → Upstream   Authorization with the proxy's own PKCE challenge
5. Upstream → Proxy    Authorization code, exchanged for upstream tokens
6. Proxy  → Client     Proxy-issued authorization code
7. Client → Proxy      Token exchange with the client's PKCE verifier
```

Two PKCE pairs are in play: one between client and proxy, one between proxy and
upstream. Neither party ever sees the other's verifier.

Only `S256` is accepted. `plain` makes the challenge and the verifier the same
value, so the secret that redeems an authorization code ends up in browser
history, referrer headers and proxy logs — RFC 7636 §4.2 requires S256 of any
client that can hash, and OAuth 2.1 removes `plain` outright. Set
`allowPlainPkce: true` for the rare client that genuinely cannot compute a
SHA-256 digest; it re-advertises `plain` in the metadata as well.

These endpoints are registered automatically:

| Endpoint                                  | Method   | Purpose                              |
| ----------------------------------------- | -------- | ------------------------------------ |
| `/oauth/register`                         | POST     | RFC 7591 Dynamic Client Registration |
| `/oauth/authorize`                        | GET      | Authorization initiation             |
| `/oauth/callback`                         | GET      | Provider callback handler            |
| `/oauth/consent`                          | GET/POST | User consent screen                  |
| `/oauth/token`                            | POST     | Token exchange and refresh           |
| `/.well-known/oauth-authorization-server` | GET      | RFC 8414 discovery metadata          |

## Quick start

### Pre-configured provider

The `auth` option is the shortest path. Everything else on this page is
optional.

```typescript
import {
  ViteMCP,
  getAuthSession,
  GoogleProvider,
  requireAuth,
} from "@vitemcp/server";

const server = new ViteMCP({
  auth: new GoogleProvider({
    baseUrl: "https://your-server.com",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    scopes: ["openid", "profile", "email"],
  }),
  name: "My Server",
  version: "1.0.0",
});

server.addTool({
  canAccess: requireAuth,
  description: "Get user profile from Google",
  execute: async (_args, { auth }) => {
    const { accessToken } = getAuthSession(auth);
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return JSON.stringify(await response.json());
  },
  name: "get-profile",
});

await server.start({
  transportType: "httpStream",
  httpStream: { port: 3000 },
});
```

Requires the `httpStream` transport.

### Any other provider

For providers without a pre-built class (Auth0, Okta, SAP, …), use
`OAuthProvider` and supply the two endpoints yourself:

```typescript
import { ViteMCP, OAuthProvider } from "@vitemcp/server";

const server = new ViteMCP({
  auth: new OAuthProvider({
    authorizationEndpoint: "https://provider.com/oauth/authorize",
    baseUrl: "https://your-server.com",
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
    scopes: ["openid", "profile"],
    tokenEndpoint: "https://provider.com/oauth/token",
  }),
  name: "My Server",
  version: "1.0.0",
});
```

### Driving the proxy directly

When you need control over proxy behaviour, construct an `OAuthProxy` and pass
it through the `oauth` option:

```typescript
import { ViteMCP } from "@vitemcp/server";
import { OAuthProxy } from "@vitemcp/server/auth";

const authProxy = new OAuthProxy({
  baseUrl: "https://your-server.com",
  scopes: ["openid", "profile"],
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: process.env.OAUTH_CLIENT_ID!,
  upstreamClientSecret: process.env.OAUTH_CLIENT_SECRET!,
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
});

const server = new ViteMCP({
  name: "My Server",
  oauth: {
    authorizationServer: authProxy.getAuthorizationServerMetadata(),
    enabled: true,
    proxy: authProxy,
  },
  version: "1.0.0",
});
```

A provider class exposes its own proxy via `getProxy()`, so you can take the
same route starting from `GoogleProvider` and friends.

## Provider setup

Every provider needs the redirect URI registered as `{baseUrl}/oauth/callback`.

### Google

Create an OAuth 2.0 Client ID in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials) with
application type "Web application".

```typescript
import { ViteMCP, GoogleProvider } from "@vitemcp/server";

const server = new ViteMCP({
  auth: new GoogleProvider({
    baseUrl: "https://your-server.com",
    clientId: "xxx.apps.googleusercontent.com",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    scopes: ["openid", "profile", "email"],
  }),
  name: "My Server",
  version: "1.0.0",
});
```

Common scopes: `openid`, `profile`, `email`,
`https://www.googleapis.com/auth/gmail.readonly`.

Google only issues a `refresh_token` when the authorization request carries
`access_type=offline` — see
[Extra authorization parameters](#extra-authorization-parameters).

### GitHub

Create an OAuth App under
[Developer Settings](https://github.com/settings/developers).

```typescript
import { ViteMCP, GitHubProvider } from "@vitemcp/server";

const server = new ViteMCP({
  auth: new GitHubProvider({
    baseUrl: "https://your-server.com",
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    scopes: ["read:user", "user:email"],
  }),
  name: "My Server",
  version: "1.0.0",
});
```

Common scopes: `read:user`, `user:email`, `repo`, `read:org`.

### Azure / Entra ID

Register an application in the
[Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
and create a client secret under "Certificates & secrets".

```typescript
import { ViteMCP, AzureProvider } from "@vitemcp/server";

const server = new ViteMCP({
  auth: new AzureProvider({
    baseUrl: "https://your-server.com",
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    scopes: ["openid", "profile", "email"],
    tenantId: "common",
  }),
  name: "My Server",
  version: "1.0.0",
});
```

`tenantId` accepts `common` (any Azure AD account), `organizations` (any
organizational account), `consumers` (personal Microsoft accounts), or a
specific tenant ID. Common scopes: `openid`, `profile`, `email`, `User.Read`,
`Mail.Read`.

Tenant-scoped providers often return an `iss` that differs from the
authorization endpoint's origin. If so, set `upstreamIssuer` to the real issuer
or the RFC 9207 check will reject the callback.

## Protecting tools

`canAccess` decides whether a tool is available. Tools it rejects are filtered
out of `tools/list` entirely, so unauthorized clients never see them.

```typescript
import {
  getAuthSession,
  requireAll,
  requireAny,
  requireAuth,
  requireRole,
  requireScopes,
} from "@vitemcp/server";

// Any authenticated user
server.addTool({ canAccess: requireAuth, name: "protected-tool" /* … */ });

// Specific OAuth scopes
server.addTool({
  canAccess: requireScopes("read:user", "write:data"),
  name: "scoped-tool",
  // …
});

// Specific role
server.addTool({ canAccess: requireRole("admin"), name: "admin-tool" /* … */ });

// AND
server.addTool({
  canAccess: requireAll(requireAuth, requireScopes("admin")),
  name: "full-access-tool",
  // …
});

// OR
server.addTool({
  canAccess: requireAny(requireRole("admin"), requireRole("moderator")),
  name: "staff-tool",
  // …
});
```

For anything these don't cover, pass a function. It receives whatever your
`authenticate` hook returned for the request — an `AuthProvider` puts the
session there:

```typescript
server.addTool({
  canAccess: (auth) => {
    if (!auth) return false;
    return auth.role === "admin" || auth.permissions?.includes("special");
  },
  description: "Custom authorization logic",
  execute: async () => "Custom access granted!",
  name: "custom-auth-tool",
});
```

Inside `execute`, `getAuthSession` gives type-safe access to the session and
throws a clear error when the request was never authenticated:

```typescript
import { getAuthSession, GoogleSession } from "@vitemcp/server";

server.addTool({
  canAccess: requireAuth,
  execute: async (_args, { auth }) => {
    const { accessToken } = getAuthSession(auth);
    // Or, with provider-specific typing:
    // const { accessToken } = getAuthSession<GoogleSession>(auth);

    const response = await fetch("https://api.example.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return JSON.stringify(await response.json());
  },
  name: "get-profile",
});
```

You can read `auth.accessToken` directly instead, but then undefined is yours to
handle.

## Configuration

```typescript
interface OAuthProxyConfig {
  // Required
  baseUrl: string;
  upstreamAuthorizationEndpoint: string;
  upstreamClientId: string;
  upstreamClientSecret: string;
  upstreamTokenEndpoint: string;

  // Flow behaviour
  allowedRedirectUriPatterns?: string[];
  allowPlainPkce?: boolean; // default: false
  authorizationCodeTtl?: number; // seconds, default: 300
  consentRequired?: boolean; // default: true
  consentSigningKey?: string; // auto-generated if absent
  extraAuthorizationParams?: Record<string, string>;
  forwardPkce?: boolean; // default: false
  redirectPath?: string; // default: "/oauth/callback"
  scopes?: string[]; // provider-specific defaults
  transactionTtl?: number; // seconds, default: 600
  upstreamIssuer?: string; // when issuer ≠ endpoint origin

  // Token swap (enabled by default)
  accessTokenTtl?: number; // seconds, default: 3600
  enableTokenSwap?: boolean; // default: true
  jwtSigningKey?: string; // auto-generated if absent
  refreshTokenTtl?: number; // seconds, default: 2592000

  // Storage
  encryptionKey?: false | string; // auto-generated if absent
  tokenStorage?: TokenStorage; // default: MemoryTokenStorage
  tokenVerifier?: TokenVerifier; // custom JWT verification
}
```

Every key that is "auto-generated if absent" regenerates on restart and differs
per process. That is fine for development and wrong for anything else — see
[Running multiple instances](#running-multiple-instances).

### Extra authorization parameters

Some providers require non-standard parameters on the authorization request.
Google, for example, only issues a `refresh_token` when the request includes
`access_type=offline`; without it access expires after an hour and can never be
renewed:

```typescript
const authProxy = new OAuthProxy({
  // …
  extraAuthorizationParams: {
    access_type: "offline", // Google: issue a refresh_token
    prompt: "consent", // Google: re-issue it on re-auth
  },
});
```

Core parameters managed by the proxy (`client_id`, `redirect_uri`,
`response_type`, `state`, `scope`, `code_challenge`, `code_challenge_method`)
cannot be overridden — entries with those keys are ignored.

### Redirect URI patterns

Controls which callback URIs clients may register:

```typescript
const authProxy = new OAuthProxy({
  // …
  allowedRedirectUriPatterns: [
    "https://*.example.com/*", // wildcard subdomain
    "http://localhost:*", // any localhost port
    "https://app.example.com/callback", // exact match
  ],
});
```

### TTLs

```typescript
const authProxy = new OAuthProxy({
  // …
  accessTokenTtl: 900, // 15 minutes — shorter is safer
  authorizationCodeTtl: 300, // 5 minutes to redeem a code
  refreshTokenTtl: 604800, // 7 days
  transactionTtl: 600, // 10 minutes to finish the flow
});
```

All values are in seconds.

### Consent

The consent screen is what stops a confused-deputy attack, so it is on by
default. It renders the requesting client and the scopes being granted, sets a
signed (HMAC-SHA256) cookie with a 5-minute TTL, and escapes everything it
prints.

```typescript
const authProxy = new GoogleProvider({
  baseUrl: "http://localhost:3000",
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  consentRequired: false, // ⚠️ local development only
});
```

## Token handling

### Token swap (default)

By default the proxy does not hand upstream tokens to clients. It stores them
server-side and issues its own short-lived JWT instead:

1. Client exchanges its authorization code.
2. Proxy exchanges upstream and receives the provider's tokens.
3. Proxy stores those tokens, encrypted.
4. Proxy returns a JWT (1 hour by default) to the client.
5. Proxy maps the JWT's `jti` back to the stored tokens on later requests.

The provider's credentials never leave your server, client tokens expire
quickly, refresh rotation is supported, and validation needs no storage lookup.

```typescript
import { DiskStore, JWTIssuer, OAuthProxy } from "@vitemcp/server/auth";

const authProxy = new OAuthProxy({
  // …
  jwtSigningKey: await JWTIssuer.deriveKey(process.env.JWT_SECRET!, 100000),
  tokenStorage: new DiskStore({ directory: "/var/lib/vitemcp/oauth" }),
});
```

To use the upstream tokens from a tool, exchange the client's JWT for them:

```typescript
server.addTool({
  description: "Call upstream API with the user's token",
  execute: async (args, { auth }) => {
    const upstreamTokens = await authProxy.loadUpstreamTokens(auth.token);
    if (!upstreamTokens) throw new Error("No valid token");

    const response = await fetch("https://api.provider.com/user", {
      headers: { Authorization: `Bearer ${upstreamTokens.accessToken}` },
    });
    return JSON.stringify(await response.json());
  },
  name: "call-api",
});
```

Mappings are cleaned up on a TTL: access-token mappings expire with the upstream
token, refresh-token mappings after 30 days by default.

### Passthrough mode

Setting `enableTokenSwap: false` returns the upstream provider's tokens to the
client verbatim and leaves lifecycle management to it. Simpler, and occasionally
useful when debugging, but the client then holds provider credentials:

```typescript
const authProxy = new OAuthProxy({
  // …
  enableTokenSwap: false,
});

const response = await authProxy.exchangeAuthorizationCode(request);
// response.access_token is the upstream provider's access token
```

### JWT issuer

`JWTIssuer` backs token swap and can be used on its own. It signs with
HMAC-SHA256 (HS256):

```typescript
import { JWTIssuer } from "@vitemcp/server/auth";

const issuer = new JWTIssuer({
  accessTokenTtl: 3600,
  audience: "https://your-server.com",
  issuer: "https://your-server.com",
  refreshTokenTtl: 2592000,
  signingKey: await JWTIssuer.deriveKey(process.env.JWT_SECRET!, 100000),
});

const accessToken = issuer.issueAccessToken("client-123", ["read", "write"]);
const result = await issuer.verify(accessToken);
if (result.valid) console.log(result.claims);
```

Issued tokens carry `iss`, `aud`, `client_id`, `scope`, `exp`, `iat`, and `jti`.
`JWTIssuer.deriveKey(secret, iterations)` runs PBKDF2 — always derive production
keys from a secret rather than passing a raw string.

### Custom claims passthrough

Enabled by default. Claims from the upstream access token and ID token are
copied into the proxy-issued JWT, which is what makes RBAC possible downstream:

```typescript
const authProxy = new OAuthProxy({
  // …
  customClaimsPassthrough: {
    allowComplexClaims: false, // primitives only (default)
    allowedClaims: ["role", "roles", "permissions", "email", "groups"],
    blockedClaims: ["internal_id"],
    claimPrefix: false, // e.g. "upstream_" to namespace them
    fromAccessToken: true,
    fromIdToken: true,
    maxClaimValueSize: 2000, // characters
  },
});
```

`customClaimsPassthrough: true` uses the defaults; `false` disables it.

Access-token claims take precedence; non-overlapping ID-token claims are merged
in. Standard JWT claims (`aud`, `iss`, `exp`, `iat`, `nbf`, `jti`, `client_id`)
are never copied. Only JWT-format tokens are inspected — opaque tokens are
skipped silently.

Using them for authorization:

```typescript
server.addTool({
  canAccess: (auth) => {
    const claims = auth?.claims ?? {};
    return claims.role === "admin" || claims.roles?.includes("admin");
  },
  description: "Access admin dashboard",
  execute: async () => "Admin dashboard data…",
  name: "admin-dashboard",
});
```

## Storage

All proxy state — client registrations, in-flight transactions, authorization
codes, token mappings — lives in the configured `TokenStorage`.

| Backend              | Persistence      | Scope             | Use for                                   |
| -------------------- | ---------------- | ----------------- | ----------------------------------------- |
| `MemoryTokenStorage` | none             | one process       | development (default)                     |
| `DiskStore`          | survives restart | one host          | single-host production                    |
| Custom               | yours            | wherever you want | more than one host (Redis, SQL, DynamoDB) |

```typescript
import { DiskStore } from "@vitemcp/server/auth";

const authProxy = new OAuthProxy({
  // …
  tokenStorage: new DiskStore({
    cleanupIntervalMs: 60000, // default: 60s; lower it under load
    directory: "/var/lib/vitemcp/oauth",
    fileExtension: ".json",
  }),
});
```

`DiskStore` cleans up expired entries on its own interval, sanitizes keys
against directory traversal, and claims entries with an atomic `rename()` — so
several processes sharing one directory are safe. It is host-local, not a
network-distributed store.

### Encryption

**Storage is encrypted by default.** The proxy wraps whatever `tokenStorage` you
give it in `EncryptedTokenStorage` (AES-256-GCM, scrypt-derived key,
authentication tag verified on read) unless it already is one. You do not need
to wrap it yourself.

```typescript
const authProxy = new OAuthProxy({
  // …
  encryptionKey: await JWTIssuer.deriveKey(
    process.env.ENCRYPTION_SECRET! + ":storage",
    100000,
  ),
  tokenStorage: new DiskStore({ directory: "/var/lib/vitemcp/oauth" }),
});
```

Supply `encryptionKey` in production. Left absent it is generated per process,
so a restart makes existing stored state unreadable. `encryptionKey: false`
disables encryption — development and testing only.

### Custom backends

Implement `TokenStorage`:

```typescript
import { TokenStorage } from "@vitemcp/server/auth";

class RedisTokenStorage implements TokenStorage {
  constructor(private redis: RedisClient) {}

  async save(key: string, value: unknown, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttl) await this.redis.setex(key, ttl, serialized);
    else await this.redis.set(key, serialized);
  }

  async get(key: string): Promise<null | unknown> {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async cleanup(): Promise<void> {
    // Redis expires keys itself.
  }

  async take(key: string): Promise<null | unknown> {
    const value = await this.redis.getdel(key);
    return value ? JSON.parse(value) : null;
  }
}
```

Two requirements:

- **Honour `ttl`.** Transactions and authorization codes are written with a TTL
  derived from their expiry. A backend that ignores it never reclaims them.
  Expired entries are still rejected on read, so this is a storage leak rather
  than a security hole — but an unbounded one.

- **Implement `take`.** It must atomically return a value and delete it, so at
  most one caller ever observes it. Authorization codes, transactions and
  refresh-token mappings are single-use (RFC 6749 §4.1.2, §10.4) and the proxy
  consumes them through `take`. This matters even in a single process, because
  the check and the delete straddle an `await`. Without it the proxy falls back
  to a non-atomic get-then-delete, where two concurrent requests can both redeem
  the same authorization code, or both redeem the same refresh token and walk
  away with two independent token chains — which defeats rotation as a
  stolen-token tripwire.

  | Backend  | Primitive                                      |
  | -------- | ---------------------------------------------- |
  | Redis    | `GETDEL key`                                   |
  | DynamoDB | `DeleteItem` with `ReturnValues: "ALL_OLD"`    |
  | SQL      | `DELETE FROM … WHERE key = $1 RETURNING value` |

  `MemoryTokenStorage` and `DiskStore` both implement it.

Because codes are consumed at the start of the exchange, a token request that
then fails validation — wrong `client_id`, bad `code_verifier` — spends the
code. The client must restart at `/oauth/authorize`. That is deliberate: a code
presented without its matching verifier has most likely leaked, so it should not
stay redeemable.

## Running multiple instances

Several instances behind a load balancer can serve different legs of the same
OAuth flow, provided three things line up.

**1. Share the storage.** Every instance must point at the same backend, and it
must implement `take`. `MemoryTokenStorage` is per-process, so it only ever
works for a single instance.

**2. Share the key material.** `consentSigningKey`, `encryptionKey`, and
`jwtSigningKey` are each generated per instance when absent. Two instances then
write state the other cannot read, and the failures are indirect: decryption
returns `null`, so a valid request surfaces as `invalid_client` or "Invalid or
expired state" rather than as a key error. Set all three explicitly, from one
secret source:

```typescript
const authProxy = new OAuthProxy({
  // …
  consentSigningKey: process.env.OAUTH_CONSENT_SIGNING_KEY,
  encryptionKey: process.env.OAUTH_ENCRYPTION_KEY,
  jwtSigningKey: process.env.OAUTH_JWT_SIGNING_KEY,
  tokenStorage: new RedisTokenStorage(redisClient),
});
```

**3. Keep clocks in sync.** JWT expiry and transaction TTLs are absolute times.

## JWKS verification

For asymmetric verification (RS256/ES256) or verifying tokens across services,
use `JWKSVerifier` in place of the default HS256 issuer. It requires the
optional `jose` peer dependency:

```bash
npm install jose
```

```typescript
import { JWKSVerifier, OAuthProxy } from "@vitemcp/server/auth";

const authProxy = new OAuthProxy({
  // …
  tokenVerifier: new JWKSVerifier({
    audience: process.env.CLIENT_ID!,
    cacheDuration: 600000, // cache keys 10 minutes (default)
    cooldownDuration: 30000, // min 30s between refetches (default)
    issuer: "https://provider.com",
    jwksUri: "https://provider.com/.well-known/jwks.json",
  }),
});
```

It can also be used standalone:

```typescript
const result = await verifier.verify(token);
if (result.valid) console.log(result.claims);
else console.log(result.error);
```

Keys are cached and the cooldown prevents hammering the JWKS endpoint during key
rotation. `jose` is loaded lazily, so it costs nothing if you never instantiate
a verifier.

Reach for JWKS when multiple services verify the same tokens, when you need
asymmetric keys, or when your provider publishes a JWKS. Stay on the default
HS256 issuer for a single server with no external verifiers — it is faster and
needs no extra dependency.

## Client registration

Dynamic Client Registration works, but is **deprecated** as of protocol revision
2026-07-28. Prefer
[Client ID Metadata Documents](../README.md#client-id-metadata-documents), where
the client identifies itself with an HTTPS URL serving its own metadata and no
registration step is needed.

If you keep CIMD enabled, set `clientIdMetadata.allowedDomains` — otherwise the
server will fetch client-supplied URLs.

## Security

### Production checklist

- [ ] HTTPS on all endpoints (`baseUrl` starts with `https://`)
- [ ] Consent screen enabled (`consentRequired: true`)
- [ ] Persistent storage (`DiskStore` or your own `TokenStorage`)
- [ ] `TokenStorage.take()` implemented — single-use enforcement depends on it
- [ ] `encryptionKey` supplied rather than auto-generated
- [ ] `jwtSigningKey` and `consentSigningKey` supplied, derived from secrets,
      minimum 32 bytes
- [ ] `allowedRedirectUriPatterns` configured
- [ ] `httpStream.allowedOrigins` set if bound to a routable interface
- [ ] `clientIdMetadata.allowedDomains` set, or CIMD disabled
- [ ] `upstreamIssuer` set if the provider's issuer differs from its
      authorization endpoint's origin
- [ ] Rate limiting in front of `/oauth/*`
- [ ] Storage cleanup monitored, key-rotation procedure written down

### Key management

Derive every key from a secret, and use a different key per purpose so that
compromising one does not compromise the others:

```typescript
const consentSigningKey = await JWTIssuer.deriveKey(
  process.env.SECRET! + ":consent",
  100000,
);
const encryptionKey = await JWTIssuer.deriveKey(
  process.env.SECRET! + ":storage",
  100000,
);
const jwtSigningKey = await JWTIssuer.deriveKey(
  process.env.SECRET! + ":jwt",
  100000,
);
```

Generate the underlying secret with real entropy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep secrets in the environment, never in source.

### What the proxy defends against

| Attack              | Mitigation                            |
| ------------------- | ------------------------------------- |
| Confused deputy     | User consent screen                   |
| Code interception   | Two-tier PKCE, S256 only              |
| Token theft         | Short-lived JWTs, encryption at rest  |
| XSS                 | HTML escaping in the consent screen   |
| CSRF                | State parameter validation            |
| Replay              | Single-use authorization codes        |
| Directory traversal | Key sanitization in `DiskStore`       |
| Mix-up              | RFC 9207 `iss` validation on callback |

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Limitations

- Server-side proxy only; there is no client-side OAuth handler.
- Proxy-issued JWTs are HS256 only. Use `JWKSVerifier` to _verify_ RS256/ES256
  tokens, but the proxy does not _issue_ them.
- No built-in token revocation endpoint.
- No general-purpose distributed locking; single-use enforcement for
  authorization codes and transactions relies on `TokenStorage.take`.
- Pre-configured providers cover Google, GitHub and Azure. Everything else goes
  through `OAuthProvider` or `OAuthProxy`, and some providers have quirks that
  need `extraAuthorizationParams` or `upstreamIssuer`.

## Troubleshooting

**"Invalid redirect URI"** — the URI registered with your provider must be
exactly `{baseUrl}/oauth/callback`, e.g.
`https://your-server.com/oauth/callback`. Check for a trailing slash.

**"Invalid state"** — the transaction expired (10 minutes by default), the
server restarted without persistent storage, key material differs between
instances, or clocks are skewed.

**"PKCE validation failed"** — the client's `code_verifier` does not match the
`code_challenge` it sent. Confirm the client stores the verifier across the
redirect and sends the same one it derived the challenge from.

**"Unsupported code_challenge_method"** — the client asked for `plain` or an
unrecognised method. Have it use `S256`; if it truly cannot, set
`allowPlainPkce: true` and read the warning above first.

**"Authorization response issuer does not match"** — the provider returned an
`iss` that is not the one this transaction started against (RFC 9207). If the
provider's issuer legitimately differs from its endpoint origin, set
`upstreamIssuer`.

**Consent screen never appears** — `consentRequired` is `false`, a valid consent
cookie is still set (clear cookies for the domain), or `consentSigningKey`
changes between requests because it is auto-generated and you run more than one
process.

**Sessions vanish on restart** — you are on the default `MemoryTokenStorage`.
Switch to `DiskStore` or a shared backend.

**Tokens expire immediately** — TTLs are in seconds, not milliseconds.

**No `refresh_token` from Google** — add
`extraAuthorizationParams: { access_type: "offline" }`.

**`Cannot find module '@vitemcp/server/auth'`** — both
`import { OAuthProxy } from "@vitemcp/server/auth"` and
`from "@vitemcp/server"` are valid; check the package is installed and your
resolver understands the `exports` map (`"moduleResolution": "bundler"` or
`"node16"`).

## Testing

```bash
npm test                              # everything
npm test -- src/auth/                 # OAuth only
```

To exercise a flow by hand, register a client, open the authorization URL in a
browser, complete consent and provider login, then redeem the code:

```bash
curl -X POST http://localhost:3000/oauth/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test Client","redirect_uris":["http://localhost:8080/callback"]}'
```

```
http://localhost:3000/oauth/authorize?client_id=<client_id>&response_type=code&redirect_uri=http://localhost:8080/callback&code_challenge=<challenge>&code_challenge_method=S256
```

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&redirect_uri=http://localhost:8080/callback&code_verifier=<verifier>&client_id=<client_id>"
```

## Examples

- [oauth-integrated-server.ts](../src/examples/oauth-integrated-server.ts) —
  Google OAuth wired into a ViteMCP server
- [oauth-proxy-server.ts](../src/examples/oauth-proxy-server.ts) — standalone
  proxy
- [oauth-proxy-github.ts](../src/examples/oauth-proxy-github.ts) — GitHub
  provider
- [oauth-proxy-custom.ts](../src/examples/oauth-proxy-custom.ts) — custom
  provider with persistent storage and derived keys
- [oauth-jwks-example.ts](../src/examples/oauth-jwks-example.ts) — JWKS
  verification

## References

- [RFC 6749](https://tools.ietf.org/html/rfc6749) — OAuth 2.0
- [RFC 7591](https://tools.ietf.org/html/rfc7591) — Dynamic Client Registration
- [RFC 7636](https://tools.ietf.org/html/rfc7636) — PKCE
- [RFC 8414](https://tools.ietf.org/html/rfc8414) — Authorization Server Metadata
- [RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) — Issuer Identification
- [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) — Protected Resource Metadata
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
