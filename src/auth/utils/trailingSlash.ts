/**
 * A URL without the slash, or slashes, it ends in.
 *
 * Every address the OAuth proxy names is its base URL with a path appended —
 * `${baseUrl}/oauth/token` — so a base URL written `https://example.com/`
 * doubled the slash: an endpoint no route answers, a callback the provider
 * never registered, and `https://example.com//mcp` as the protected resource.
 */
export const withoutTrailingSlash = (url: string): string =>
  url.replace(/\/+$/, "");
