/**
 * The `authenticate` gate on the HTTP transport.
 *
 * The rule under test: a hook that does not return a session has refused the
 * request. Before this was enforced, a nullish result was indistinguishable
 * from "no `authenticate` configured" — the exchange proceeded with
 * `context.auth === undefined`, so every tool, resource and prompt without a
 * `canAccess` guard answered callers who had presented no credentials at all.
 * `AuthProvider.authenticate` returns `undefined` for a missing or invalid
 * bearer token, which made that the default outcome of the `auth` option.
 */
import { describe, expect, it } from "vitest";

import { GitHubProvider } from "./auth/providers/GitHubProvider.js";
import { ViteMCP } from "./ViteMCP.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

type Session = { id: number };

const callTool = (port: number, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
        arguments: {},
        name: "secret",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "secret",
      ...headers,
    },
    method: "POST",
  });

/** Runs `body` against a started server carrying one unguarded tool. */
const withServer = async (
  options: Partial<ConstructorParameters<typeof ViteMCP<Session>>[0]>,
  body: (port: number, calls: { count: number }) => Promise<void>,
) => {
  const calls = { count: 0 };

  const server = new ViteMCP<Session>({
    name: "Auth",
    version: "1.0.0",
    ...options,
  });

  // Deliberately unguarded: `canAccess` is the wrong place to catch this, and
  // a server whose author forgot it is precisely the case that regressed.
  server.addTool({
    description: "Leaks unless the transport refuses first",
    execute: async () => {
      calls.count += 1;
      return "TOP SECRET";
    },
    name: "secret",
  });

  await server.start({ httpStream: { port: 0 }, transportType: "httpStream" });

  try {
    await body(server.port!, calls);
  } finally {
    await server.stop();
  }
};

describe("authenticate gate", () => {
  it("refuses a request whose hook resolved with undefined", async () => {
    await withServer(
      { authenticate: async () => undefined },
      async (port, calls) => {
        const response = await callTool(port);

        expect(response.status).toBe(401);
        expect(calls.count).toBe(0);
        expect(await response.json()).toMatchObject({ error: "invalid_token" });
      },
    );
  });

  it("refuses a request whose hook resolved with null", async () => {
    await withServer(
      { authenticate: async () => null },
      async (port, calls) => {
        expect((await callTool(port)).status).toBe(401);
        expect(calls.count).toBe(0);
      },
    );
  });

  it("refuses a request whose hook resolved with another falsy value", async () => {
    await withServer(
      // Only reachable from untyped callers, which is why it is pinned.
      { authenticate: async () => false as unknown as Session },
      async (port, calls) => {
        expect((await callTool(port)).status).toBe(401);
        expect(calls.count).toBe(0);
      },
    );
  });

  it("challenges with WWW-Authenticate so the client can find the login", async () => {
    await withServer({ authenticate: async () => undefined }, async (port) => {
      const challenge = (await callTool(port)).headers.get("WWW-Authenticate");

      expect(challenge).toContain("Bearer");
      expect(challenge).toContain('error="invalid_token"');
    });
  });

  it("points the challenge at the protected-resource document", async () => {
    await withServer(
      {
        authenticate: async () => undefined,
        oauth: {
          protectedResource: {
            authorizationServers: ["https://auth.example.com"],
            resource: "http://localhost/mcp",
          },
        },
      },
      async (port) => {
        const challenge = (await callTool(port)).headers.get(
          "WWW-Authenticate",
        );

        expect(challenge).toContain(
          `resource_metadata="http://localhost:${port}/.well-known/oauth-protected-resource/mcp"`,
        );

        // The advertised URL must actually serve the document — a challenge
        // pointing at a 404 sends the client nowhere.
        const metadata = await fetch(
          `http://localhost:${port}/.well-known/oauth-protected-resource/mcp`,
        );

        expect(metadata.status).toBe(200);
      },
    );
  });

  it("omits resource_metadata when the server publishes none", async () => {
    await withServer({ authenticate: async () => undefined }, async (port) => {
      const challenge = (await callTool(port)).headers.get("WWW-Authenticate");

      expect(challenge).not.toContain("resource_metadata");
    });
  });

  it("serves a request whose hook returned a session", async () => {
    await withServer(
      {
        authenticate: async (request) =>
          request.headers.get("x-api-key") === "let-me-in"
            ? { id: 1 }
            : undefined,
      },
      async (port, calls) => {
        const response = await callTool(port, { "x-api-key": "let-me-in" });

        expect(response.status).toBe(200);
        expect(calls.count).toBe(1);
        expect(await response.text()).toContain("TOP SECRET");
      },
    );
  });

  it("returns a Response thrown by the hook verbatim", async () => {
    await withServer(
      {
        authenticate: async () => {
          throw new Response("go away", {
            headers: { "X-Reason": "no-key" },
            status: 403,
          });
        },
      },
      async (port, calls) => {
        const response = await callTool(port);

        expect(response.status).toBe(403);
        expect(response.headers.get("X-Reason")).toBe("no-key");
        expect(await response.text()).toBe("go away");
        expect(calls.count).toBe(0);
      },
    );
  });

  it("fails closed when the hook throws something that is not a Response", async () => {
    await withServer(
      {
        authenticate: async () => {
          throw new Error("verifier unreachable");
        },
        // Silence the expected error report.
        logger: { ...console, error: () => {} },
      },
      async (port, calls) => {
        expect((await callTool(port)).status).toBe(500);
        expect(calls.count).toBe(0);
      },
    );
  });

  it("serves anonymously when allowAnonymous is set", async () => {
    await withServer(
      { allowAnonymous: true, authenticate: async () => undefined },
      async (port, calls) => {
        const response = await callTool(port);

        expect(response.status).toBe(200);
        expect(calls.count).toBe(1);
      },
    );
  });

  it("hands allowAnonymous callers an undefined auth, not a fabricated one", async () => {
    const seen: unknown[] = [];

    const server = new ViteMCP<Session>({
      allowAnonymous: true,
      authenticate: async () => undefined,
      name: "Auth",
      version: "1.0.0",
    });

    server.addTool({
      canAccess: (auth) => {
        seen.push(auth);
        return true;
      },
      description: "Records what canAccess saw",
      execute: async (_args, { auth }) =>
        JSON.stringify({ auth: auth ?? null }),
      name: "secret",
    });

    await server.start({
      httpStream: { port: 0 },
      transportType: "httpStream",
    });

    try {
      expect(await (await callTool(server.port!)).text()).toContain(
        '{\\"auth\\":null}',
      );
      expect(seen).toEqual([undefined]);
    } finally {
      await server.stop();
    }
  });

  it("gates the 2025-era fallback transport too", async () => {
    await withServer(
      { authenticate: async () => undefined },
      async (port, calls) => {
        // No `Mcp-Method`/`Mcp-Name` and no modern protocol version: this is
        // routed to the legacy stateless handler, which shares the factory and
        // so used to share the hole.
        const response = await fetch(`http://localhost:${port}/mcp`, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: {}, name: "secret" },
          }),
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        expect(response.status).toBe(401);
        expect(calls.count).toBe(0);
      },
    );
  });

  it("keeps concurrent requests on their own sessions", async () => {
    const seen: (number | undefined)[] = [];

    const server = new ViteMCP<Session>({
      // Staggered so the exchanges genuinely overlap: the first hook to start
      // is the last to resolve, which is what a per-instance field would get
      // wrong.
      authenticate: async (request) => {
        const id = Number(request.headers.get("x-id"));
        await new Promise((resolve) => setTimeout(resolve, 60 - id * 10));
        return { id };
      },
      name: "Auth",
      version: "1.0.0",
    });

    server.addTool({
      description: "Echoes the caller",
      execute: async (_args, { auth }) => {
        seen.push(auth?.id);
        return String(auth?.id);
      },
      name: "secret",
    });

    await server.start({
      httpStream: { port: 0 },
      transportType: "httpStream",
    });

    try {
      const bodies = await Promise.all(
        [1, 2, 3, 4, 5].map(async (id) =>
          (await callTool(server.port!, { "x-id": String(id) })).text(),
        ),
      );

      for (const [index, body] of bodies.entries()) {
        expect(body).toContain(`"text":"${index + 1}"`);
      }

      expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await server.stop();
    }
  });

  it("closes the endpoint when auth is an AuthProvider", async () => {
    // The realistic exposure: `AuthProvider.authenticate` answers `undefined`
    // for a missing or unknown bearer token, so every server configured this
    // way served anonymous callers whatever had no `canAccess` guard.
    const auth = new GitHubProvider({
      allowedRedirectUriPatterns: ["http://localhost:*"],
      baseUrl: "http://localhost",
      clientId: "id",
      clientSecret: "secret",
    });

    const calls = { count: 0 };

    const server = new ViteMCP({
      auth,
      name: "Auth",
      version: "1.0.0",
    });

    server.addTool({
      description: "Unguarded on purpose",
      execute: async () => {
        calls.count += 1;
        return "TOP SECRET";
      },
      name: "secret",
    });

    await server.start({
      httpStream: { port: 0 },
      transportType: "httpStream",
    });

    try {
      const cases: Record<string, string>[] = [
        {},
        { Authorization: "Bearer not-a-real-token" },
      ];

      for (const headers of cases) {
        const response = await callTool(server.port!, headers);

        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toContain(
          "resource_metadata=",
        );
      }

      expect(calls.count).toBe(0);
    } finally {
      await server.stop();
      auth.destroy();
    }
  });

  it("leaves stdio and connect() alone — there is no request to authenticate", async () => {
    const server = new ViteMCP<Session>({
      authenticate: async () => undefined,
      name: "Auth",
      version: "1.0.0",
    });

    server.addTool({
      description: "Callable in-process",
      execute: async () => "TOP SECRET",
      name: "secret",
    });

    const { Client, InMemoryTransport } =
      await import("@modelcontextprotocol/client");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "c", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ arguments: {}, name: "secret" });
      expect(JSON.stringify(result)).toContain("TOP SECRET");
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
