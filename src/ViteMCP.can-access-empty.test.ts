/**
 * What a caller sees when `canAccess` hides every member of a primitive family.
 *
 * `canAccess` is documented to filter rejected primitives out of the list, so
 * a caller who may see none of them is owed an empty list. `#buildServer`
 * registers only what survived filtering, and the SDK registers a family's
 * request handlers on the first `registerTool`/`registerResource`/
 * `registerPrompt` — so a request that registered nothing used to answer
 * `-32601 Method not found`, which says `tools/list` does not exist rather
 * than that this caller may see nothing in it.
 *
 * A server that carries none of a primitive at all is a different case, and
 * `-32601` remains the right answer there: it genuinely does not support the
 * family, and advertising it would be a lie.
 */
import { describe, expect, it, vi } from "vitest";

import { ViteMCP } from "./ViteMCP.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

type Session = { role: string };

const LIST_METHODS = [
  ["tools/list", "tools"],
  ["prompts/list", "prompts"],
  ["resources/list", "resources"],
  ["resources/templates/list", "resourceTemplates"],
] as const;

const call = async (
  port: number,
  method: string,
  token: string,
  params: Record<string, unknown> = {},
) => {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
        ...params,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Mcp-Method": method,
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    method: "POST",
  });

  return (await response.json()) as {
    error?: { code: number; message: string };
    result?: Record<string, unknown>;
  };
};

const admin = (auth: Session | undefined) => auth?.role === "admin";

/** A server whose every primitive is admin-only, started on a free port. */
const withAdminOnlyServer = async (body: (port: number) => Promise<void>) => {
  const server = new ViteMCP<Session>({
    authenticate: async (request) => ({
      role: request.headers.get("authorization")?.includes("admin")
        ? "admin"
        : "user",
    }),
    name: "Gated",
    version: "1.0.0",
  });

  server.addTool({
    canAccess: admin,
    description: "Admin only",
    execute: async () => "ok",
    name: "secret",
  });
  server.addPrompt({ canAccess: admin, load: async () => "hi", name: "brief" });
  server.addResource({
    canAccess: admin,
    load: async () => ({ text: "x" }),
    mimeType: "text/plain",
    name: "dossier",
    uri: "file:///dossier",
  });
  server.addResourceTemplate({
    arguments: [{ name: "id" }],
    canAccess: admin,
    load: async () => ({ text: "x" }),
    mimeType: "text/plain",
    name: "record",
    uriTemplate: "file:///record/{id}",
  });

  await server.start({ httpStream: { port: 0 }, transportType: "httpStream" });

  try {
    await body(server.port!);
  } finally {
    await server.stop();
  }
};

describe("canAccess hides every member of a family", () => {
  it("answers each list method with an empty list, not -32601", async () => {
    await withAdminOnlyServer(async (port) => {
      for (const [method, key] of LIST_METHODS) {
        const body = await call(port, method, "user");

        expect(body.error, `${method} should not error`).toBeUndefined();
        expect(body.result?.[key], `${method} should be empty`).toEqual([]);
      }
    });
  });

  it("declares the families the server supports", async () => {
    await withAdminOnlyServer(async (port) => {
      const body = await call(port, "server/discover", "user");

      // Capabilities describe what the server supports, not what this caller
      // may see — a client that reads them must still be able to call the
      // list method and be told, truthfully, that it may see nothing.
      expect(body.result?.capabilities).toEqual({
        logging: {},
        prompts: { listChanged: true },
        resources: { listChanged: true },
        tools: { listChanged: true },
      });
    });
  });

  it("does not expose the hidden primitives to the caller who may not see them", async () => {
    await withAdminOnlyServer(async (port) => {
      const body = await call(port, "tools/call", "user", {
        arguments: {},
        name: "secret",
      });

      expect(body.error?.message).toBe("Tool secret not found");
    });
  });

  it("leaves the placeholder that latches the handlers unreachable", async () => {
    await withAdminOnlyServer(async (port) => {
      const body = await call(port, "tools/call", "user", {
        arguments: {},
        name: "vitemcp.internal.capability-latch",
      });

      // Indistinguishable from any other unknown tool: registering it is an
      // implementation detail, and it must not become part of the wire API.
      expect(body.error?.message).toBe(
        "Tool vitemcp.internal.capability-latch not found",
      );
    });
  });

  it("registers the placeholder without tripping the SDK's name validator", async () => {
    // The SDK validates a tool name on registration and warns about anything
    // outside `A-Za-z0-9._-`. The placeholder is registered on every
    // fully-filtered request, so a non-conforming name would put five warning
    // lines into the log of every such request.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await withAdminOnlyServer(async (port) => {
        await call(port, "tools/list", "user");
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("still serves the caller who may see them", async () => {
    await withAdminOnlyServer(async (port) => {
      const body = await call(port, "tools/list", "admin");

      expect(
        (body.result?.tools as { name: string }[]).map((tool) => tool.name),
      ).toEqual(["secret"]);
    });
  });
});

describe("a server carrying none of a primitive", () => {
  it("advertises no primitive family and leaves the list methods absent", async () => {
    const server = new ViteMCP({ name: "Bare", version: "1.0.0" });

    await server.start({
      httpStream: { port: 0 },
      transportType: "httpStream",
    });

    try {
      for (const [method] of LIST_METHODS) {
        expect((await call(server.port!, method, "x")).error?.code).toBe(
          -32601,
        );
      }

      // `logging` is not a family: it has no list method to leave absent.
      expect(
        (await call(server.port!, "server/discover", "x")).result?.capabilities,
      ).toEqual({ logging: {} });
    } finally {
      await server.stop();
    }
  });
});
