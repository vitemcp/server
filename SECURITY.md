# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Report privately through
[GitHub Security Advisories](https://github.com/vitemcp/vitemcp/security/advisories/new),
which creates a private thread with the maintainers and can be converted into a
published advisory with credit to you.

If that is not available to you, email `frank@glama.ai` with `[SECURITY]` in the
subject.

### What to include

The more of this you can provide, the faster a fix lands:

- Affected version(s), and whether `main` is affected
- The component — `ViteMCP` core, the OAuth proxy, the edge runtime, the CLI
- Reproduction steps, ideally a minimal script or failing test
- What an attacker gains, and what preconditions they need
- Any suggested fix

### What to expect

- **Acknowledgement** within 3 working days
- **An initial assessment** — whether we can reproduce it, and our severity read
  — within 7 working days
- **Fix and release** timed to severity; we will tell you the target and keep you
  updated if it moves
- **Credit** in the advisory unless you would rather stay anonymous

We will publish a GitHub Security Advisory and request a CVE for issues that
warrant one. If we disagree with your severity assessment we will say so and
explain why, rather than quietly downgrading it.

## Scope

In scope:

- The `@vitemcp/server` package and everything under `src/`
- The OAuth proxy and its authorization, token, registration and discovery
  endpoints
- Protocol handling — request validation, transport security, session-free
  request isolation

Out of scope:

- Vulnerabilities in dependencies — report those upstream, though do tell us if
  ViteMCP's usage makes an upstream issue exploitable when it otherwise would
  not be
- Misconfiguration in a downstream application, unless ViteMCP's defaults make
  the misconfiguration likely
- Anything requiring an attacker to already control the server process

## Security-relevant configuration

A few defaults are worth knowing about when deploying:

| Setting                     | Default                                                       | Why it matters                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `httpStream.allowedOrigins` | loopback hostnames when bound to loopback; otherwise **none** | Guards against DNS rebinding. Bound to a routable interface, browser origins are rejected until you configure this.                                                                                          |
| `httpStream.legacy`         | `"stateless"`                                                 | Also serves 2025-era clients. Those requests skip the mandatory `Mcp-Method`/`Mcp-Name` validation. Set `"reject"` for a strictly modern endpoint.                                                           |
| `httpStream.maxBodySize`    | 1 MiB                                                         | Request bodies are rejected past this without being buffered.                                                                                                                                                |
| `clientIdMetadata`          | enabled                                                       | Resolving a URL-formatted `client_id` fetches a client-supplied URL. Internal addresses and redirects are refused; set `allowedDomains` to narrow it to hosts you trust, or `enabled: false` to turn it off. |
| `oauth.proxy` token storage | in-memory                                                     | Tokens do not survive a restart and are not shared between instances. Use `DiskStore` or your own `TokenStorage` in production, and implement `take()` for atomic single-use enforcement.                    |
