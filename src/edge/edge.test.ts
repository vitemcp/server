import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
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
