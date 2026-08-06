import { type } from "arktype";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { runWithTestServer, withoutEnvelope } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

// The README documents Zod, ArkType and Valibot as supported parameter
// validators (all wired through the Standard Schema spec), but only Zod is
// exercised by the test suite. These tests cover the ArkType and Valibot
// paths end-to-end — JSON Schema exposure in tools/list plus runtime
// validation on tools/call — so a regression in the non-Zod validators or
// their JSON-Schema conversion can't slip through unnoticed.

describe("tool schema registration", () => {
  it("rejects parameters without Standard Schema support before starting a server", () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    expect(() =>
      server.addTool({
        execute: async () => "ok",
        name: "legacy-zod",
        parameters: {} as never,
      }),
    ).toThrow(
      "Tool 'legacy-zod' parameters must implement Standard Schema. If you are using Zod, upgrade to version 3.24 or later.",
    );
  });

  it("rejects output schemas without Standard Schema support before starting a server", () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    expect(() =>
      server.addTool({
        execute: async () => "ok",
        name: "legacy-zod-output",
        outputSchema: {} as never,
      }),
    ).toThrow(
      "Tool 'legacy-zod-output' outputSchema must implement Standard Schema. If you are using Zod, upgrade to version 3.24 or later.",
    );
  });
});

describe("tool parameters via ArkType", () => {
  it("exposes the parameters as JSON Schema in tools/list", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: type({ a: "number", b: "number" }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const { tools } = await client.listTools();

        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
          inputSchema: {
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
            type: "object",
          },
          name: "add",
        });
      },
      server,
    });
  });

  it("validates and forwards valid arguments to execute", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: type({ a: "number", b: "number" }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { a: 1, b: 2 },
              name: "add",
            }),
          ),
        ).toEqual({
          content: [{ text: "3", type: "text" }],
        });
      },
      server,
    });
  });

  it("rejects invalid arguments before execute runs", async () => {
    let executed = false;
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => {
        executed = true;
        return String(args.a + args.b);
      },
      name: "add",
      parameters: type({ a: "number", b: "number" }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        // v2 surfaces schema violations as an error *result* rather than a
        // JSON-RPC rejection; either way `execute` must not run.
        const result = await client.callTool({
          arguments: { a: "not-a-number", b: 2 },
          name: "add",
        });
        expect(result.isError).toBe(true);
        expect(executed).toBe(false);
      },
      server,
    });
  });
});

describe("tool parameters via Valibot", () => {
  it("exposes the parameters as JSON Schema in tools/list", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: v.object({ a: v.number(), b: v.number() }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const { tools } = await client.listTools();

        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
          inputSchema: {
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
            type: "object",
          },
          name: "add",
        });
      },
      server,
    });
  });

  it("validates and forwards valid arguments to execute", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: v.object({ a: v.number(), b: v.number() }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { a: 1, b: 2 },
              name: "add",
            }),
          ),
        ).toEqual({
          content: [{ text: "3", type: "text" }],
        });
      },
      server,
    });
  });

  it("rejects invalid arguments before execute runs", async () => {
    let executed = false;
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => {
        executed = true;
        return String(args.a + args.b);
      },
      name: "add",
      parameters: v.object({ a: v.number(), b: v.number() }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        // v2 surfaces schema violations as an error *result* rather than a
        // JSON-RPC rejection; either way `execute` must not run.
        const result = await client.callTool({
          arguments: { a: "not-a-number", b: 2 },
          name: "add",
        });
        expect(result.isError).toBe(true);
        expect(executed).toBe(false);
      },
      server,
    });
  });

  it("handles optional parameters", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Greet someone",
      execute: async (args) => `Hello, ${args.name ?? "world"}`,
      name: "greet",
      parameters: v.object({ name: v.optional(v.string()) }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        expect(
          withoutEnvelope(
            await client.callTool({ arguments: {}, name: "greet" }),
          ),
        ).toEqual({
          content: [{ text: "Hello, world", type: "text" }],
        });
        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { name: "Ada" },
              name: "greet",
            }),
          ),
        ).toEqual({
          content: [{ text: "Hello, Ada", type: "text" }],
        });
      },
      server,
    });
  });
});
