/**
 * RFC 8252 §7.3 loopback redirect matching.
 *
 * A native client binds an ephemeral loopback port, so the port cannot be known
 * when the client declares its redirect URIs — a Client ID Metadata Document is
 * published once and served to every installation. RFC 8252 §7.3 therefore
 * requires the authorization server to ignore the port when comparing loopback
 * redirect URIs:
 *
 *   "The authorization server MUST allow any port to be specified at the time
 *    of the request for loopback IP redirect URIs, to accommodate clients that
 *    obtain an available ephemeral port from the operating system at the time
 *    of the request."
 *
 * Only a declaration that omits the port is relaxed, and only the port may
 * differ: scheme, host, path, query and fragment are compared exactly, and
 * userinfo is refused outright on both sides (`http://localhost:@evil.com`
 * navigates to evil.com). A declaration that names a port means that port.
 */

/** Hosts whose port may vary, per RFC 8252 §7.3 and RFC 6761 §6.3. */
const LOOPBACK_HOSTS = new Set(["::1", "127.0.0.1", "localhost"]);

const parse = (uri: string): null | URL => {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
};

/**
 * Whether `requested` is `declared` with only a port added — the single
 * difference RFC 8252 §7.3 permits. Everything else must be identical.
 */
export function loopbackRedirectMatches(
  declared: string,
  requested: string,
): boolean {
  if (declared === requested) {
    return true;
  }

  const a = parse(declared);
  const b = parse(requested);

  if (!a || !b) {
    return false;
  }

  // Plaintext loopback only: an https redirect is a real, addressable endpoint
  // whose port is part of its identity.
  if (a.protocol !== "http:" || b.protocol !== "http:") {
    return false;
  }

  // `URL` normalises `[::1]` to the bracketed form in `hostname`; strip the
  // brackets so the set lookup sees the address itself.
  const host = a.hostname.replace(/^\[|\]$/g, "");

  if (!LOOPBACK_HOSTS.has(host) || a.hostname !== b.hostname) {
    return false;
  }

  // Only a portless declaration is relaxed; one that names a port means it.
  if (a.port !== "") {
    return false;
  }

  if (
    a.username !== "" ||
    a.password !== "" ||
    b.username !== "" ||
    b.password !== ""
  ) {
    return false;
  }

  return (
    a.pathname === b.pathname && a.search === b.search && a.hash === b.hash
  );
}
