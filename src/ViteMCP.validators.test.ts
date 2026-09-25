import { type } from "arktype";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

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

/** A Standard Schema from a library xsschema has no converter for. */
const unconvertible = {
  "~standard": {
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
    vendor: "hand-rolled",
    version: 1 as const,
  },
};

// Valibot has no JSON Schema of its own, so its schemas are converted for
// tools/list, while Valibot itself still validates. Closing every object in
// the advertised copy — as inputs are documented to be — must not swallow the
// keys a record or rest schema describes.
describe("Valibot schemas converted to JSON Schema", () => {
  it("keeps a record's value schema, so its keys are accepted", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (args) => JSON.stringify(args),
      name: "label",
      parameters: v.object({ labels: v.record(v.string(), v.string()) }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const { tools } = await client.listTools();

        expect(tools[0].inputSchema.additionalProperties).toBe(false);
        expect(tools[0].inputSchema.properties?.labels).toMatchObject({
          additionalProperties: { type: "string" },
        });

        // A key the schema does not declare is dropped by Valibot, as Zod
        // drops one, rather than reaching execute.
        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { extra: true, labels: { team: "infra" } },
              name: "label",
            }),
          ),
        ).toEqual({
          content: [{ text: '{"labels":{"team":"infra"}}', type: "text" }],
        });

        const wrongValue = await client.callTool({
          arguments: { labels: { team: 42 } },
          name: "label",
        });
        expect(wrongValue.isError).toBe(true);
      },
      server,
    });
  });

  it("validates with Valibot itself, so a transform reaches execute", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (args) => `${typeof args.n} ${args.n + 1}`,
      name: "increment",
      parameters: v.object({ n: v.pipe(v.string(), v.transform(Number)) }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const [tool] = (await client.listTools()).tools;

        // Advertised as what the caller sends: the input side of the transform.
        expect(tool.inputSchema.properties?.n).toEqual({ type: "string" });
        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { n: "41" },
              name: "increment",
            }),
          ),
        ).toEqual({ content: [{ text: "number 42", type: "text" }] });
      },
      server,
    });
  });

  it("enforces a check that JSON Schema cannot express", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (args) => `hello ${args.name}`,
      name: "greet",
      parameters: v.object({
        name: v.pipe(
          v.string(),
          v.check((name) => name === name.trim(), "must not be padded"),
        ),
      }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const [tool] = (await client.listTools()).tools;

        expect(tool.inputSchema.properties?.name).toEqual({ type: "string" });

        const padded = await client.callTool({
          arguments: { name: " Ada " },
          name: "greet",
        });
        expect(padded.isError).toBe(true);
        expect(JSON.stringify(padded.content)).toContain("must not be padded");

        expect(
          withoutEnvelope(
            await client.callTool({
              arguments: { name: "Ada" },
              name: "greet",
            }),
          ),
        ).toEqual({ content: [{ text: "hello Ada", type: "text" }] });
      },
      server,
    });
  });

  it("keeps an object's rest schema", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (args) => JSON.stringify(args),
      name: "count",
      parameters: v.objectWithRest({ id: v.string() }, v.number()),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const { tools } = await client.listTools();

        expect(tools[0].inputSchema.additionalProperties).toEqual({
          type: "number",
        });
        expect(
          (
            await client.callTool({
              arguments: { apples: 3, id: "a" },
              name: "count",
            })
          ).isError,
        ).toBeFalsy();
        expect(
          (
            await client.callTool({
              arguments: { apples: "three", id: "a" },
              name: "count",
            })
          ).isError,
        ).toBe(true);
      },
      server,
    });
  });

  it("still closes input objects that declare properties", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async () => "ok",
      name: "own",
      parameters: v.object({ owner: v.looseObject({ name: v.string() }) }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const [tool] = (await client.listTools()).tools;

        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.inputSchema.properties?.owner).toMatchObject({
          additionalProperties: false,
        });
      },
      server,
    });
  });

  it("leaves output schemas as converted, so a record result is not a tool error", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async () => ({ stock: { berlin: 3, paris: 5 } }),
      name: "stock",
      outputSchema: v.object({ stock: v.record(v.string(), v.number()) }),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const [tool] = (await client.listTools()).tools;
        const properties = tool.outputSchema?.properties as
          | Record<string, unknown>
          | undefined;

        expect(tool.outputSchema?.additionalProperties).toBeUndefined();
        expect(properties?.stock).toMatchObject({
          additionalProperties: { type: "number" },
        });

        const result = await client.callTool({ arguments: {}, name: "stock" });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
          stock: { berlin: 3, paris: 5 },
        });
      },
      server,
    });
  });

  it("leaves out a tool whose schema cannot be converted, and serves the rest", async () => {
    const error = vi.fn();
    const noop = () => {};
    const server = new ViteMCP({
      logger: { debug: noop, error, info: noop, log: noop, warn: noop },
      name: "Test",
      version: "1.0.0",
    });

    server.addTool({
      execute: async () => "ok",
      name: "healthy",
      parameters: v.object({}),
    });
    server.addTool({
      execute: async () => "unreachable",
      name: "opaque",
      parameters: unconvertible,
    });

    // Before, the failed conversion failed every request, the handshake too.
    await runWithTestServer({
      run: async ({ client }) => {
        for (let request = 0; request < 2; request++) {
          const { tools } = await client.listTools();
          expect(tools.map((tool) => tool.name)).toEqual(["healthy"]);
        }

        expect(
          withoutEnvelope(
            await client.callTool({ arguments: {}, name: "healthy" }),
          ),
        ).toEqual({ content: [{ text: "ok", type: "text" }] });

        // Reported once, not on every request.
        expect(error).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith(
          '[ViteMCP error] Tool "opaque" is not served:',
          expect.objectContaining({
            message: expect.stringContaining('vendor "hand-rolled"'),
          }),
        );
      },
      server,
    });
  });

  it("answers an empty tools/list when no tool can be served", async () => {
    const noop = () => {};
    const server = new ViteMCP({
      logger: { debug: noop, error: noop, info: noop, log: noop, warn: noop },
      name: "Test",
      version: "1.0.0",
    });

    server.addTool({
      execute: async () => "unreachable",
      name: "opaque",
      parameters: unconvertible,
    });

    await runWithTestServer({
      run: async ({ client }) => {
        expect((await client.listTools()).tools).toEqual([]);
      },
      server,
    });
  });

  it("explains what to install when @valibot/to-json-schema is missing", async () => {
    vi.doMock("@valibot/to-json-schema", () => {
      throw new Error("Cannot find package '@valibot/to-json-schema'");
    });
    vi.resetModules();

    try {
      const { ViteMCP: FreshViteMCP } = await import("./ViteMCP.js");
      const error = vi.fn();
      const noop = () => {};
      const server = new FreshViteMCP({
        logger: { debug: noop, error, info: noop, log: noop, warn: noop },
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        execute: async () => "unreachable",
        name: "add",
        parameters: v.object({ a: v.number() }),
      });

      await runWithTestServer({
        run: async ({ client }) => {
          expect((await client.listTools()).tools).toEqual([]);
          expect(error).toHaveBeenCalledWith(
            '[ViteMCP error] Tool "add" is not served:',
            expect.objectContaining({
              message: expect.stringContaining(
                "npm install @valibot/to-json-schema",
              ),
            }),
          );
        },
        server,
      });
    } finally {
      vi.doUnmock("@valibot/to-json-schema");
      vi.resetModules();
    }
  });
});
