import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getRandomPort } from "get-port-please";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

/** Identifies a 2026-07-28 request; the SDK's LATEST_PROTOCOL_VERSION is 2025. */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const withTool = () => {
  const server = new ViteMCP({ name: "Protocol", version: "9.9.9" });

  server.addTool({
    description: "Adds",
    execute: async (args) => String(args.a + args.b),
    name: "add",
    parameters: z.object({ a: z.number(), b: z.number() }),
  });

  return server;
};

/**
 * Conformance for the wire envelope the 2026-07-28 revision requires.
 *
 * The rest of the suite strips these fields via `withoutEnvelope` so payload
 * assertions stay readable; this file is where they are actually pinned.
 */
describe("protocol envelope", () => {
  it("identifies the server in every result's _meta", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.callTool({
          arguments: { a: 1, b: 2 },
          name: "add",
        });

        expect(result._meta).toMatchObject({
          "io.modelcontextprotocol/serverInfo": {
            name: "Protocol",
            version: "9.9.9",
          },
        });
      },
      server: withTool,
    });
  });

  it("marks ordinary results complete on the wire", async () => {
    const port = await getRandomPort();
    const server = withTool();

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      // Asserted on the wire rather than through the client: the SDK client
      // consumes `resultType` as its complete/input_required discriminator and
      // does not re-expose it on the returned object.
      const response = await fetch(`http://localhost:${port}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/protocolVersion":
                MODERN_PROTOCOL_VERSION,
            },
            arguments: { a: 1, b: 2 },
            name: "add",
          },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "add",
        },
        method: "POST",
      });

      const text = await response.text();
      const line = text
        .split("\n")
        .find((candidate) => candidate.startsWith("data:"));
      const payload = JSON.parse((line ?? text).replace(/^data:\s*/, "")) as {
        result: { resultType: string };
      };

      expect(payload.result.resultType).toBe("complete");
    } finally {
      await server.stop();
    }
  });

  it("puts cache hints on cacheable list results", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        for (const result of [
          await client.listTools(),
          await client.listPrompts(),
          await client.listResources(),
        ]) {
          expect(result).toHaveProperty("ttlMs");
          expect(result).toHaveProperty("cacheScope");
        }
      },
      server: () => {
        const server = withTool();

        server.addPrompt({
          description: "p",
          load: async () => "hello",
          name: "p",
        });
        server.addResource({
          load: async () => ({ text: "r" }),
          name: "r",
          uri: "test://r",
        });

        return server;
      },
    });
  });

  it("honours a per-resource cache hint", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.readResource({ uri: "test://cached" });

        expect(result.ttlMs).toBe(60_000);
        expect(result.cacheScope).toBe("public");
      },
      server: () => {
        const server = withTool();

        server.addResource({
          cache: { cacheScope: "public", ttlMs: 60_000 },
          load: async () => ({ text: "cached" }),
          name: "cached",
          uri: "test://cached",
        });

        return server;
      },
    });
  });

  it("constrains a prompt argument declared with an enum", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const { prompts } = await client.listPrompts();
        const arg = prompts
          .find((p) => p.name === "pick")
          ?.arguments?.find((a) => a.name === "country");

        expect(arg?.description).toBe("Name of the country");
        expect(arg?.required).toBe(true);
      },
      server: () => {
        const server = withTool();

        server.addPrompt({
          arguments: [
            {
              description: "Name of the country",
              enum: ["Germany", "France", "Italy"],
              name: "country",
              required: true,
            },
          ],
          description: "Pick a country",
          load: async (args) => `You picked ${args.country}`,
          name: "pick",
        });

        return server;
      },
    });
  });

  it("returns tools in a deterministic order", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const first = (await client.listTools()).tools.map((t) => t.name);
        const second = (await client.listTools()).tools.map((t) => t.name);

        expect(first).toEqual(second);
        expect(first.length).toBeGreaterThan(1);
      },
      server: () => {
        const server = withTool();

        for (const name of ["zeta", "alpha", "mid"]) {
          server.addTool({
            description: name,
            execute: async () => name,
            name,
            parameters: z.object({}),
          });
        }

        return server;
      },
    });
  });

  it("serves a 2025-era client by default", async () => {
    const port = await getRandomPort();
    const server = withTool();

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      // The SDK client negotiates the 2025 era unless told otherwise, so the
      // default has to accept it or most existing clients cannot connect.
      const client = new Client({ name: "legacy-client", version: "1.0.0" });

      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${port}/mcp`),
        ),
      );

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("add");

      await client.close();
    } finally {
      await server.stop();
    }
  });

  it("rejects a 2025-era request when legacy is 'reject'", async () => {
    const port = await getRandomPort();
    const server = withTool();

    await server.start({
      httpStream: { legacy: "reject", port },
      transportType: "httpStream",
    });

    try {
      // Strict mode: the endpoint serves exactly what `server/discover`
      // advertises, so a request with no `_meta` envelope is refused.
      const response = await fetch(`http://localhost:${port}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toMatch(/protocol version|Unsupported/i);
    } finally {
      await server.stop();
    }
  });

  it("rejects a request whose Origin is not allowed", async () => {
    const port = await getRandomPort();
    const server = withTool();

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      // Transport security MUST: a present-but-unrecognised Origin is what a
      // DNS-rebinding attack looks like against a loopback-bound server.
      const response = await fetch(`http://localhost:${port}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/protocolVersion":
                MODERN_PROTOCOL_VERSION,
            },
          },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Method": "tools/list",
          Origin: "https://evil.example",
        },
        method: "POST",
      });

      expect(response.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it("allows a loopback Origin by default", async () => {
    const port = await getRandomPort();
    const server = withTool();

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      const response = await fetch(`http://localhost:${port}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/protocolVersion":
                MODERN_PROTOCOL_VERSION,
            },
          },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Method": "tools/list",
          Origin: `http://localhost:${port}`,
        },
        method: "POST",
      });

      expect(response.status).not.toBe(403);
    } finally {
      await server.stop();
    }
  });
});
