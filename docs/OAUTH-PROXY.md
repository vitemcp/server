# OAuth Proxy for ViteMCP

Lets MCP clients authenticate against providers that do not support Dynamic
Client Registration, by presenting a DCR-compliant face to the client while
using pre-registered credentials upstream.

This page is the index and the operational reference. The task-oriented
material lives in the documents below rather than being repeated here.

## Documentation

| Document                                            | Covers                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **[Implementation Guide](oauth-proxy-guide.md)**    | Quick start, provider setup (Google, GitHub, Azure), configuration, troubleshooting                     |
| **[Features](oauth-proxy-features.md)**             | Capabilities, storage backends, limitations                                                             |
| **[Advanced Features](oauth-advanced-features.md)** | Persistent storage, JWT issuance, token swap, encryption                                                |
| **[Examples](../src/examples/)**                    | `oauth-integrated-server.ts`, `oauth-proxy-server.ts`, `oauth-proxy-github.ts`, `oauth-proxy-custom.ts` |

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

## Client registration

Dynamic Client Registration still works, but is **deprecated** as of protocol
revision 2026-07-28. Prefer
[Client ID Metadata Documents](../README.md#client-id-metadata-documents): the
client identifies itself with an HTTPS URL serving its own metadata, so no
registration step is needed.

## Production checklist

- [ ] HTTPS on all endpoints
- [ ] Consent screen enabled (`consentRequired: true`)
- [ ] Persistent storage (`DiskStore` or your own `TokenStorage`)
- [ ] `TokenStorage.take()` implemented — single-use enforcement depends on it
- [ ] Encryption key supplied rather than auto-generated (it changes per restart)
- [ ] Signing keys derived from secrets, minimum 32 bytes
- [ ] `allowedRedirectUriPatterns` configured
- [ ] `httpStream.allowedOrigins` set if bound to a routable interface
- [ ] `clientIdMetadata.allowedDomains` set, or CIMD disabled, if you do not
      want the server fetching arbitrary client URLs
- [ ] `upstreamIssuer` set if the provider's issuer differs from its
      authorization endpoint's origin (tenant-scoped providers)
- [ ] Rate limiting in front of `/oauth/*`

## Troubleshooting

**"Invalid redirect URI"** — the URI registered with your provider must be
exactly `{baseUrl}/oauth/callback`.

**"Invalid state"** — the transaction expired (10 minutes by default), the
server restarted without persistent storage, or clocks are skewed.

**"PKCE validation failed"** — the client's `code_verifier` does not match the
`code_challenge` it sent.

**"Authorization response issuer does not match"** — the provider returned an
`iss` that is not the one this transaction started against (RFC 9207). If the
provider's issuer legitimately differs from its endpoint origin, set
`upstreamIssuer`.

More in the [Implementation Guide](oauth-proxy-guide.md#troubleshooting).

## References

- [RFC 6749](https://tools.ietf.org/html/rfc6749) — OAuth 2.0
- [RFC 7591](https://tools.ietf.org/html/rfc7591) — Dynamic Client Registration
- [RFC 7636](https://tools.ietf.org/html/rfc7636) — PKCE
- [RFC 8414](https://tools.ietf.org/html/rfc8414) — Authorization Server Metadata
- [RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) — Issuer Identification
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
