import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EdgeViteMCP } from "./index.js";

/**
 * Edge server tests for the 2026-07-28 revision.
 *
 * The `initialize` handshake and `ping` are gone from the protocol, so the
 * tests that covered them are gone too — capability discovery is now
 * `server/discover`, and every request is self-contained.
 *
 * The streamable transport answers with SSE unless the caller opts out, so
 * responses are parsed through a helper rather than `response.json()`.
 */

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

type JsonRpcResponse = {
  error?: { code: number; message: string };
  id: number;
  jsonrpc: string;
  result: Record<string, unknown>;
};

/** Parses either a plain JSON body or a single SSE `data:` frame. */
const readRpc = async (response: Response): Promise<JsonRpcResponse> => {
  const text = await response.text();

  if (text.startsWith("event:") || text.startsWith("data:")) {
    const line = text
      .split("\n")
      .find((candidate) => candidate.startsWith("data:"));

    return JSON.parse(line!.slice("data:".length).trim());
  }

  return JSON.parse(text);
};

/**
 * Every 2026-07-28 request carries its protocol version and client
 * capabilities in `_meta`; without the envelope the server classifies the
 * request as 2025-era, where methods like `server/discover` do not exist.
 */
// Note: the SDK's `LATEST_PROTOCOL_VERSION` is the *legacy* handshake
// constant (2025-11-25). The modern era is identified by this literal.
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const envelope = {
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
};

const call = async (
  server: EdgeViteMCP,
  method: string,
  params: Record<string, unknown> = {},
  path = "/mcp",
): Promise<JsonRpcResponse> => {
  const response = await server.fetch(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params: { ...params, _meta: envelope },
      }),
      // SEP-2243 requires the standard MCP request headers on streamable
      // POSTs: `Mcp-Method` always, and `Mcp-Name` whenever the body names a
      // target (`params.name` or `params.uri`). The server rejects a
      // header/body mismatch with -32020.
      headers: {
        ...MCP_HEADERS,
        "Mcp-Method": method,
        ...(typeof params.name === "string"
          ? { "Mcp-Name": params.name }
          : typeof params.uri === "string"
            ? { "Mcp-Name": params.uri }
            : {}),
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  return readRpc(response);
};

const makeServer = () =>
  new EdgeViteMCP({ name: "TestServer", version: "1.0.0" });

describe("EdgeViteMCP", () => {
  it("advertises itself through server/discover", async () => {
    const body = await call(makeServer(), "server/discover");

    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
  });

  it("should list tools", async () => {
    const server = makeServer();

    server.addTool({
      description: "Greet someone",
      execute: async ({ name }) => `Hello, ${name}!`,
      name: "greet",
      parameters: z.object({ name: z.string() }),
    });

    const body = await call(server, "tools/list");
    const tools = (body.result as { tools: { name: string }[] }).tools;

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
  });

  it("should call a tool", async () => {
    const server = makeServer();

    server.addTool({
      description: "Greet someone",
      execute: async ({ name }) => `Hello, ${name}!`,
      name: "greet",
      parameters: z.object({ name: z.string() }),
    });

    const body = await call(server, "tools/call", {
      arguments: { name: "World" },
      name: "greet",
    });

    const content = (body.result as { content: { text: string }[] }).content;
    expect(content[0].text).toBe("Hello, World!");
  });

  it("should list and read resources", async () => {
    const server = makeServer();

    server.addResource({
      description: "A test resource",
      load: async () => "resource contents",
      mimeType: "text/plain",
      name: "Test Resource",
      uri: "test://resource",
    });

    const listed = await call(server, "resources/list");
    const resources = (listed.result as { resources: { uri: string }[] })
      .resources;
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("test://resource");

    const read = await call(server, "resources/read", {
      uri: "test://resource",
    });
    const contents = (read.result as { contents: { text: string }[] }).contents;
    expect(contents[0].text).toBe("resource contents");
  });

  it("should list and get prompts", async () => {
    const server = makeServer();

    server.addPrompt({
      arguments: [{ name: "topic", required: true }],
      description: "A test prompt",
      load: async (args) => `Tell me about ${args.topic}`,
      name: "explain",
    });

    const listed = await call(server, "prompts/list");
    const prompts = (listed.result as { prompts: { name: string }[] }).prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("explain");

    const got = await call(server, "prompts/get", {
      arguments: { topic: "otters" },
      name: "explain",
    });
    const messages = (
      got.result as { messages: { content: { text: string } }[] }
    ).messages;
    expect(messages[0].content.text).toBe("Tell me about otters");
  });

  // The SDK calls a handler that declares no schema with its request context
  // alone, which used to reach `execute` and `load` as their arguments.
  it("hands a tool without parameters no arguments", async () => {
    const server = makeServer();
    const received: unknown[] = [];

    server.addTool({
      description: "Report status",
      execute: async (params) => {
        received.push(params);
        return "ok";
      },
      name: "status",
    });

    await call(server, "tools/call", { arguments: {}, name: "status" });

    expect(received).toEqual([undefined]);
  });

  it("hands a prompt without arguments an empty object", async () => {
    const server = makeServer();
    const received: unknown[] = [];

    server.addPrompt({
      load: async (args) => {
        received.push(args);
        return "Summarise the last deploy.";
      },
      name: "summary",
    });

    await call(server, "prompts/get", { name: "summary" });

    expect(received).toEqual([{}]);
  });

  // Valibot carries no JSON Schema of its own, and the SDK refuses to list a
  // tool without one — which failed `tools/list` for every tool on the server,
  // not only the Valibot one.
  it("serves a tool written with Valibot", async () => {
    const server = makeServer();

    server.addTool({
      description: "Greet someone",
      execute: async ({ name }) => `Hello, ${name}!`,
      name: "greet",
      parameters: v.object({ name: v.pipe(v.string(), v.trim()) }),
    });

    const listed = await call(server, "tools/list");
    const [tool] = (
      listed.result as { tools: { inputSchema: unknown; name: string }[] }
    ).tools;

    expect(tool).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        properties: { name: { type: "string" } },
        required: ["name"],
        type: "object",
      },
      name: "greet",
    });

    // Validated by Valibot itself, so the transform reaches `execute`.
    const called = await call(server, "tools/call", {
      arguments: { name: "  World " },
      name: "greet",
    });

    expect(
      (called.result as { content: { text: string }[] }).content[0].text,
    ).toBe("Hello, World!");
  });

  it("leaves out a tool whose schema cannot be advertised, and serves the rest", async () => {
    const error = vi.fn();
    const noop = () => {};
    const server = new EdgeViteMCP({
      logger: { debug: noop, error, info: noop, log: noop, warn: noop },
      name: "TestServer",
      version: "1.0.0",
    });

    server.addTool({
      description: "Greet someone",
      execute: async ({ name }) => `Hello, ${name}!`,
      name: "greet",
      parameters: z.object({ name: z.string() }),
    });
    server.addTool({
      description: "Written with a library that carries no JSON Schema",
      execute: async () => "unreachable",
      name: "opaque",
      parameters: {
        "~standard": {
          validate: (value: unknown) => ({ value }),
          vendor: "hand-rolled",
          version: 1 as const,
        },
      },
    });

    for (let request = 0; request < 2; request++) {
      const listed = await call(server, "tools/list");

      expect(
        (listed.result as { tools: { name: string }[] }).tools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["greet"]);
    }

    // Reported once, not on every request.
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      '[EdgeViteMCP] Tool "opaque" is not served:',
      expect.objectContaining({
        message: expect.stringContaining('"hand-rolled"'),
      }),
    );
  });

  it("serves custom routes alongside the MCP endpoint", async () => {
    const server = makeServer();
    server.getApp().get("/health", (c) => c.text("ok"));

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("should return an error for invalid JSON", async () => {
    const response = await makeServer().fetch(
      new Request("http://localhost/mcp", {
        body: "not json",
        headers: MCP_HEADERS,
        method: "POST",
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("should reject a request that does not accept event-stream", async () => {
    const response = await makeServer().fetch(
      new Request("http://localhost/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
        headers: { Accept: "text/plain", "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(406);
  });

  it("should allow a custom MCP path", async () => {
    const server = new EdgeViteMCP({
      mcpPath: "/api/mcp",
      name: "TestServer",
      version: "1.0.0",
    });

    // A tool has to exist for `tools/list` to be registered at all — the SDK
    // only wires up a capability's handlers once something uses it.
    server.addTool({
      description: "Greet someone",
      execute: async ({ name }) => `Hello, ${name}!`,
      name: "greet",
      parameters: z.object({ name: z.string() }),
    });

    const body = await call(server, "tools/list", {}, "/api/mcp");
    const tools = (body.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(1);

    // The default path must not respond on this server.
    const wrongPath = await server.fetch(
      new Request("http://localhost/mcp", { method: "POST" }),
    );
    expect(wrongPath.status).toBe(404);
  });
});

/**
 * The MCP endpoint's request body cap. The Node transport has always had one;
 * this entry point handed the request straight to the SDK, which reads whatever
 * it is given in full.
 */
describe("EdgeViteMCP request body cap", () => {
  const MIB = 1024 * 1024;

  /** A server whose one tool reports how much it was sent. */
  const measuring = (options: { maxBodySize?: number } = {}) => {
    const received: number[] = [];
    const server = new EdgeViteMCP({
      name: "TestServer",
      version: "1.0.0",
      ...options,
    });

    server.addTool({
      description: "Reports the size of what it was sent",
      execute: async ({ blob }) => {
        received.push(blob.length);
        return `received ${blob.length}`;
      },
      name: "measure",
      parameters: z.object({ blob: z.string() }),
    });

    return { received, server };
  };

  const post = (server: EdgeViteMCP, body: ReadableStream | string) =>
    server.fetch(
      new Request("http://localhost/mcp", {
        body,
        duplex: "half",
        headers: {
          ...MCP_HEADERS,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "measure",
        },
        method: "POST",
      }),
    );

  const callWith = (characters: number) =>
    JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: envelope,
        arguments: { blob: "x".repeat(characters) },
        name: "measure",
      },
    });

  it("refuses a body over 1 MiB by default", async () => {
    const { received, server } = measuring();
    const response = await post(server, callWith(2 * MIB));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Request body exceeds 1 MiB",
    });
    expect(received).toEqual([]);
  });

  it("stops reading a body of undeclared length once it passes the cap", async () => {
    const { server } = measuring();
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    let cancelled = false;

    // No Content-Length to refuse up front, as with a chunked upload: the cap
    // has to be enforced on the bytes actually read.
    const response = await post(
      server,
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulled += 1;

          if (pulled > 64) {
            controller.close();
            return;
          }

          controller.enqueue(chunk);
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: "Request body exceeds 1 MiB",
    });

    // 4 MiB were on offer; reading stopped just past the first.
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(24);
  });

  it("answers a body that fails mid-stream instead of throwing", async () => {
    const noop = () => {};
    const server = new EdgeViteMCP({
      logger: { debug: noop, error: noop, info: noop, log: noop, warn: noop },
      name: "TestServer",
      version: "1.0.0",
    });
    let pulled = 0;

    const response = await post(
      server,
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;

          if (pulled === 1) {
            controller.enqueue(new Uint8Array(16));
            return;
          }

          controller.error(new Error("client went away"));
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Request body could not be read",
    });
  });

  it("accepts a larger body when maxBodySize is raised", async () => {
    const { received, server } = measuring({ maxBodySize: 4 * MIB });
    const response = await post(server, callWith(2 * MIB));

    expect(response.status).toBe(200);
    expect(received).toEqual([2 * MIB]);
  });
});
