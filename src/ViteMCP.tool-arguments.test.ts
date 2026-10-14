/**
 * Tool arguments named like a member of `Object.prototype`.
 *
 * Zod and Valibot read a key through the prototype chain, so one the client
 * left out but `Object.prototype` has — `toString`, `constructor`, `valueOf` —
 * arrived as a function, at any depth: an optional one could never be left
 * out, and a required one was reported as the wrong type instead of as
 * missing. AJV, behind `jsonSchemaAdapter`, did the same. ArkType refuses to
 * define such a key at all, so it has no case here.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { type } from "arktype";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { jsonSchemaAdapter } from "./jsonSchemaAdapter.js";
import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

type CallToolResult = {
  content: { text?: string; type: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};

/** Serves `parameters` as tool "t" and calls it with `args`. */
const callTool = async ({
  args,
  execute = async () => "ok",
  outputSchema,
  parameters,
}: {
  args: Record<string, unknown>;
  execute?: (args: unknown) => Promise<unknown>;
  outputSchema?: StandardSchemaV1;
  parameters: StandardSchemaV1;
}): Promise<CallToolResult> => {
  let result: CallToolResult | undefined;
  const server = new ViteMCP({ name: "Test", version: "1.0.0" });

  server.addTool({
    execute: execute as never,
    name: "t",
    outputSchema: outputSchema as never,
    parameters: parameters as never,
  });

  await runWithTestServer({
    run: async ({ client }) => {
      result = (await client.callTool({
        arguments: args,
        name: "t",
      })) as CallToolResult;
    },
    server,
  });

  return result!;
};

const LIBRARIES = [
  {
    missing: /received undefined/,
    name: "Zod",
    optional: z.object({
      constructor: z.string().optional(),
      options: z.object({ valueOf: z.string().optional() }),
      toString: z.string().optional(),
    }),
    required: z.object({ constructor: z.string() }),
  },
  {
    missing: /received undefined/,
    name: "Valibot",
    optional: v.object({
      constructor: v.optional(v.string()),
      options: v.object({ valueOf: v.optional(v.string()) }),
      toString: v.optional(v.string()),
    }),
    required: v.object({ constructor: v.string() }),
  },
  {
    missing: /must have required property 'constructor'/,
    name: "jsonSchemaAdapter",
    optional: jsonSchemaAdapter({
      properties: {
        constructor: { type: "string" },
        options: {
          properties: { valueOf: { type: "string" } },
          type: "object",
        },
        toString: { type: "string" },
      },
      required: ["options"],
      type: "object",
    }),
    required: jsonSchemaAdapter({
      properties: { constructor: { type: "string" } },
      required: ["constructor"],
      type: "object",
    }),
  },
];

describe.each(LIBRARIES)(
  "a tool argument named like a member of Object.prototype, with $name",
  ({ missing, optional, required }) => {
    it("can be left out when it is optional, at any depth", async () => {
      const execute = vi.fn(async () => "ok");

      const result = await callTool({
        args: { options: {} },
        execute,
        parameters: optional,
      });

      expect(result.isError).toBeUndefined();
      expect(execute).toHaveBeenCalledWith({ options: {} }, expect.anything());
    });

    it("arrives as sent", async () => {
      const execute = vi.fn(async () => "ok");
      const args = {
        constructor: "a",
        options: { valueOf: "b" },
        toString: "c",
      };

      await callTool({ args, execute, parameters: optional });

      expect(execute).toHaveBeenCalledWith(args, expect.anything());
    });

    it("is reported missing when it is required", async () => {
      const execute = vi.fn(async () => "ok");

      const result = await callTool({
        args: {},
        execute,
        parameters: required,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(missing);
      expect(execute).not.toHaveBeenCalled();
    });
  },
);

describe("validating tool arguments by their own keys", () => {
  it("still hands execute ordinary objects", async () => {
    // ArkType and AJV hand back the very object they validated, which is the
    // copy without prototypes that ViteMCP had them validate; so does Zod, for
    // a value it does not parse.
    const schemas = [
      type({
        items: [{ "id?": "string" }, "[]"],
        options: { "level?": "string" },
      }),
      jsonSchemaAdapter({
        properties: { items: { type: "array" }, options: { type: "object" } },
        type: "object",
      }),
      z.object({ items: z.array(z.unknown()), options: z.unknown() }),
    ];

    for (const parameters of schemas) {
      const received: { items: object[]; options: object }[] = [];

      await callTool({
        args: { items: [{ id: "a" }], options: { level: "debug" } },
        execute: async (args) => {
          received.push(args as never);
          return "ok";
        },
        parameters,
      });

      const [args] = received;

      expect(
        [args, args.options, args.items[0]].map(Object.getPrototypeOf),
      ).toEqual([Object.prototype, Object.prototype, Object.prototype]);
      expect(String(args.options)).toBe("[object Object]");
    }
  });

  it("lets structured content leave out an optional property named like one", async () => {
    const result = await callTool({
      args: {},
      execute: async () => ({ ok: true }),
      outputSchema: z.object({
        ok: z.boolean(),
        toString: z.string().optional(),
      }),
      parameters: z.object({}),
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("leaves the tool's own schema as it was", async () => {
    const parameters = z.object({ toString: z.string().optional() });
    const standard = parameters["~standard"];

    await callTool({ args: {}, parameters });

    expect(parameters["~standard"]).toBe(standard);
  });
});
