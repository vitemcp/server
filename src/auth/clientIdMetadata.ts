/**
 * OAuth Client ID Metadata Documents (CIMD).
 *
 * A client identifies itself with an HTTPS URL serving a JSON document, which
 * the server fetches on demand — so **the server can be induced to request an
 * attacker-chosen URL**. Everything defensive here exists for that reason.
 *
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, request } from "undici";

/** Metadata document as served by the client. */
export interface ClientIdMetadata {
  application_type?: "native" | "web";
  client_id: string;
  client_name: string;
  client_uri?: string;
  grant_types?: string[];
  logo_uri?: string;
  redirect_uris: string[];
  response_types?: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
}

export interface ClientIdMetadataOptions {
  /**
   * Trust policy: hosts allowed to serve metadata. Exact match, or suffix when
   * written `.example.com`. Omitted allows any public host.
   */
  allowedDomains?: string[];
  /** How long a fetched document may be reused when the response gives no cache headers. */
  defaultCacheTtlMs?: number;
  /** Whether CIMD is served at all. */
  enabled?: boolean;
  /** Abort a metadata fetch after this long. */
  fetchTimeoutMs?: number;
  /** Reject documents larger than this. */
  maxDocumentBytes?: number;
}

const DEFAULTS = {
  defaultCacheTtlMs: 5 * 60 * 1000,
  fetchTimeoutMs: 5_000,
  maxDocumentBytes: 64 * 1024,
} as const;

/**
 * Address ranges a metadata fetch must never reach. Link-local matters most:
 * 169.254.169.254 serves cloud instance credentials.
 */
const isBlockedIpv4 = (ip: string): boolean => {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast and reserved
  );
};

const isBlockedIpv6 = (ip: string): boolean => {
  const address = ip.toLowerCase().split("%")[0];

  // IPv4-mapped (::ffff:a.b.c.d) must be judged on the embedded IPv4.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") || // unique local
    address.startsWith("fd") || // unique local
    address.startsWith("fe8") || // link-local
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb") ||
    address.startsWith("ff") // multicast
  );
};

const isBlockedAddress = (ip: string, family: number): boolean =>
  family === 4 ? isBlockedIpv4(ip) : isBlockedIpv6(ip);

/** URL hostnames wrap IPv6 literals in brackets; `isIP` does not accept those. */
const stripBrackets = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

/**
 * A dispatcher whose DNS resolution rejects internal addresses.
 *
 * Checking the hostname before fetching would leave a rebinding window — the
 * name could resolve publicly during the check and internally at connect.
 * Hooking the connection's own lookup means the validated address is the
 * connected one.
 */
const ssrfSafeAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }

        const resolved = Array.isArray(addresses) ? addresses : [addresses];
        const blocked = resolved.find((entry) =>
          isBlockedAddress(entry.address, entry.family),
        );

        if (blocked || resolved.length === 0) {
          callback(
            new Error(
              `Refusing to fetch client metadata from an internal address (${blocked?.address ?? "unresolved"})`,
            ),
            "",
            0,
          );
          return;
        }

        // Preserve the caller's shape: `all` decides array vs single.
        if (options.all) {
          callback(null, resolved as never, 0 as never);
        } else {
          callback(null, resolved[0].address, resolved[0].family);
        }
      });
    },
  },
});

export class ClientIdMetadataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClientIdMetadataError";
  }
}

/** True when a client_id is a CIMD URL rather than an opaque identifier. */
export const isClientIdMetadataUrl = (clientId: string): boolean => {
  try {
    const url = new URL(clientId);
    // Spec requires https and a path; a bare origin only widens the surface.
    return url.protocol === "https:" && url.pathname.length > 1;
  } catch {
    return false;
  }
};

const hostAllowed = (host: string, allowed: string[] | undefined): boolean => {
  if (!allowed?.length) {
    return true;
  }

  return allowed.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) : host === entry,
  );
};

/** Seconds of freshness the response permits, if it says. */
const cacheTtlFromHeaders = (
  headers: Record<string, string | string[] | undefined>,
): null | number => {
  const control = headers["cache-control"];
  const value = Array.isArray(control) ? control[0] : control;

  if (!value) {
    return null;
  }

  if (/\bno-store\b|\bno-cache\b/i.test(value)) {
    return 0;
  }

  const maxAge = value.match(/\bmax-age=(\d+)/i);

  return maxAge ? Number(maxAge[1]) * 1000 : null;
};

interface CacheEntry {
  expiresAt: number;
  metadata: ClientIdMetadata;
}

/**
 * Parses and validates a metadata document body. Pure so the structural rules
 * are testable without a server (the SSRF guard refuses loopback).
 *
 * @throws {ClientIdMetadataError} when the document is unusable.
 */
export const validateClientIdMetadata = (
  body: string,
  clientId: string,
): ClientIdMetadata => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ClientIdMetadataError("Client metadata is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClientIdMetadataError("Client metadata must be a JSON object");
  }

  const doc = parsed as Record<string, unknown>;

  // MUST: the document has to claim the exact URL it was served from, or a
  // third party could host a document impersonating someone else's client.
  if (doc.client_id !== clientId) {
    throw new ClientIdMetadataError(
      "Client metadata client_id does not match the document URL",
    );
  }

  if (typeof doc.client_name !== "string" || !doc.client_name) {
    throw new ClientIdMetadataError("Client metadata is missing client_name");
  }

  if (
    !Array.isArray(doc.redirect_uris) ||
    doc.redirect_uris.length === 0 ||
    !doc.redirect_uris.every((uri) => typeof uri === "string")
  ) {
    throw new ClientIdMetadataError("Client metadata is missing redirect_uris");
  }

  return doc as unknown as ClientIdMetadata;
};

/**
 * Resolves URL-formatted client_ids to their metadata documents, with
 * SSRF defences and caching.
 */
export class ClientIdMetadataResolver {
  public get enabled(): boolean {
    return this.#options.enabled;
  }
  #cache = new Map<string, CacheEntry>();

  #options: {
    allowedDomains?: string[];
  } & Required<Omit<ClientIdMetadataOptions, "allowedDomains">>;

  public constructor(options: ClientIdMetadataOptions = {}) {
    this.#options = {
      allowedDomains: options.allowedDomains,
      defaultCacheTtlMs:
        options.defaultCacheTtlMs ?? DEFAULTS.defaultCacheTtlMs,
      enabled: options.enabled ?? true,
      fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs,
      maxDocumentBytes: options.maxDocumentBytes ?? DEFAULTS.maxDocumentBytes,
    };
  }

  /** Drops cached documents (mainly for tests). */
  public clearCache(): void {
    this.#cache.clear();
  }

  /**
   * Fetches and validates the metadata document for a client_id URL.
   *
   * @throws {ClientIdMetadataError} on a bad URL, refused fetch, or invalid
   * document.
   */
  public async resolve(clientId: string): Promise<ClientIdMetadata> {
    if (!this.#options.enabled) {
      throw new ClientIdMetadataError(
        "Client ID Metadata Documents are not enabled",
      );
    }

    if (!isClientIdMetadataUrl(clientId)) {
      throw new ClientIdMetadataError(
        "client_id must be an https URL with a path component",
      );
    }

    const cached = this.#cache.get(clientId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const url = new URL(clientId);

    if (!hostAllowed(url.hostname, this.#options.allowedDomains)) {
      throw new ClientIdMetadataError(
        `Client metadata host is not allowed: ${url.hostname}`,
      );
    }

    // Literals never reach the DNS hook — no name to resolve — so they must
    // be checked here or they bypass the guard entirely.
    const literalFamily = isIP(stripBrackets(url.hostname));

    if (
      literalFamily !== 0 &&
      isBlockedAddress(stripBrackets(url.hostname), literalFamily)
    ) {
      throw new ClientIdMetadataError(
        `Refusing to fetch client metadata from an internal address (${url.hostname})`,
      );
    }

    const { body, headers } = await this.#fetchDocument(url);
    const metadata = validateClientIdMetadata(body, clientId);

    const ttl = cacheTtlFromHeaders(headers) ?? this.#options.defaultCacheTtlMs;

    if (ttl > 0) {
      this.#cache.set(clientId, {
        expiresAt: Date.now() + ttl,
        metadata,
      });
    }

    return metadata;
  }

  async #fetchDocument(url: URL): Promise<{
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }> {
    let response;

    try {
      response = await request(url, {
        dispatcher: ssrfSafeAgent,
        headers: { accept: "application/json" },
        headersTimeout: this.#options.fetchTimeoutMs,
        // No redirect interceptor is installed, so redirects are not
        // followed: a hop to an internal address is the classic SSRF bypass.
        method: "GET",
        signal: AbortSignal.timeout(this.#options.fetchTimeoutMs),
      });
    } catch (error) {
      throw new ClientIdMetadataError(
        `Could not fetch client metadata: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (response.statusCode >= 300) {
      response.body.destroy();
      throw new ClientIdMetadataError(
        `Client metadata returned HTTP ${response.statusCode}`,
      );
    }

    // Hard cap: an endless body must not exhaust memory.
    let size = 0;
    const chunks: Buffer[] = [];

    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.byteLength;

      if (size > this.#options.maxDocumentBytes) {
        response.body.destroy();
        throw new ClientIdMetadataError(
          `Client metadata exceeds ${this.#options.maxDocumentBytes} bytes`,
        );
      }

      chunks.push(buf);
    }

    return {
      body: Buffer.concat(chunks).toString("utf8"),
      headers: response.headers,
    };
  }
}
