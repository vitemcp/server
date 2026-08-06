/** OAuth proxy HTTP routes, as a Hono router. */
import { Hono } from "hono";

import type { OAuthProxy } from "./OAuthProxy.js";

/** Bodies larger than this are rejected before parsing (DoS guard). */
export const OAUTH_PROXY_MAX_BODY_SIZE = 1024 * 1024;

type OAuthErrorish = {
  statusCode?: number;
  toJSON?: () => unknown;
};

const errorResponse = (error: unknown) => {
  const err = error as OAuthErrorish;
  return {
    body: err.toJSON?.() ?? { error: "invalid_request" },
    status: (err.statusCode ?? 400) as 400,
  };
};

/**
 * Reads a body under a hard cap, enforced *while* reading — measuring after
 * buffering would let a client push arbitrary bytes into memory.
 *
 * Returns `null` when the body is too large, aborted, or unreadable.
 */
const readCappedBody = async (request: Request): Promise<null | string> => {
  const declared = request.headers.get("content-length");

  if (declared && Number(declared) > OAUTH_PROXY_MAX_BODY_SIZE) {
    return null;
  }

  if (!request.body) {
    try {
      const text = await request.text();
      return text.length > OAUTH_PROXY_MAX_BODY_SIZE ? null : text;
    } catch {
      return null;
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > OAUTH_PROXY_MAX_BODY_SIZE) {
        await reader.cancel().catch(() => {});
        return null;
      }

      chunks.push(value);
    }
  } catch {
    // Aborted or errored mid-body: settle rather than leaving it pending.
    return null;
  }

  return Buffer.concat(chunks).toString("utf8");
};

const readJsonBody = async (request: Request): Promise<null | unknown> => {
  const text = await readCappedBody(request);

  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const tooLarge = {
  error: "invalid_request",
  error_description: `Request body exceeds ${OAUTH_PROXY_MAX_BODY_SIZE / (1024 * 1024)} MiB`,
};

/**
 * RFC 8414 / 9728 metadata is snake_case on the wire; config is camelCase.
 * Top-level keys only — nested values are caller-defined payloads.
 */
const toSnakeCase = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
      v,
    ]),
  );
};

export type OAuthRouterOptions = {
  authorizationServer?: unknown;
  /** Path prefix the server is mounted under, e.g. "/issuer1". */
  basePath?: string;
  /** MCP endpoint path, e.g. "/mcp". */
  endpoint?: string;
  protectedResource?: unknown;
  /** Optional: discovery metadata can be served without a proxy. */
  proxy?: OAuthProxy;
};

export const createOAuthRouter = (options: OAuthRouterOptions): Hono => {
  const app = new Hono();
  const { proxy } = options;

  const basePath = options.basePath ?? "";
  const endpoint = options.endpoint ?? "";

  // RFC 8414 §3 / 9728 §3: exact routes, not wildcards — an unrelated suffix
  // must 404 rather than serve metadata.
  const serve = (path: string, body: unknown) =>
    app.get(path, (c) => c.json(body as never));

  if (options.authorizationServer) {
    // Issuer-scoped: under a base path, the bare root is not valid.
    serve(
      `/.well-known/oauth-authorization-server${basePath}`,
      toSnakeCase(options.authorizationServer),
    );
  }

  if (options.protectedResource) {
    const body = toSnakeCase(options.protectedResource);
    const scoped = `/.well-known/oauth-protected-resource${basePath}${endpoint}`;

    // Sub-path takes priority; root stays as the documented fallback.
    serve(scoped, body);

    if (scoped !== "/.well-known/oauth-protected-resource") {
      serve("/.well-known/oauth-protected-resource", body);
    }
  }

  if (!proxy) {
    return app;
  }

  // RFC 7591 Dynamic Client Registration.
  app.post(`${basePath}/oauth/register`, async (c) => {
    const body = await readJsonBody(c.req.raw);

    if (body === null) {
      return c.json(tooLarge, 400);
    }

    try {
      return c.json(await proxy.registerClient(body as never), 201);
    } catch (error) {
      const { body: errBody, status } = errorResponse(error);
      return c.json(errBody as never, status);
    }
  });

  app.get(`${basePath}/oauth/authorize`, async (c) => {
    try {
      const params = Object.fromEntries(
        new URL(c.req.url).searchParams.entries(),
      );
      return await proxy.authorize(params as never);
    } catch (error) {
      const { body, status } = errorResponse(error);
      return c.json(body as never, status);
    }
  });

  app.post(`${basePath}/oauth/token`, async (c) => {
    const raw = c.req.raw;
    const text = await readCappedBody(raw);

    if (text === null) {
      return c.json(tooLarge, 400);
    }

    try {
      const params = Object.fromEntries(new URLSearchParams(text).entries());

      // RFC 6749 §2.3.1: credentials may arrive via Basic auth. Body wins.
      const authHeader = raw.headers.get("authorization");

      if (authHeader?.toLowerCase().startsWith("basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
          "utf8",
        );
        const separator = decoded.indexOf(":");

        if (separator !== -1) {
          params.client_id ||= decodeURIComponent(decoded.slice(0, separator));
          params.client_secret ||= decodeURIComponent(
            decoded.slice(separator + 1),
          );
        }
      }

      const result =
        params.grant_type === "refresh_token"
          ? await proxy.exchangeRefreshToken(params as never)
          : await proxy.exchangeAuthorizationCode(params as never);

      return c.json(result as never);
    } catch (error) {
      const { body, status } = errorResponse(error);
      return c.json(body as never, status);
    }
  });

  app.get(`${basePath}/oauth/callback`, async (c) =>
    proxy.handleCallback(c.req.raw),
  );

  app.all(`${basePath}/oauth/consent`, async (c) =>
    proxy.handleConsent(c.req.raw),
  );

  return app;
};
