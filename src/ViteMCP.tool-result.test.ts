/**
 * End-to-end coverage for the tool-result routing in `normalizeToolResult`:
 * which of the shapes `execute` may return becomes content, which becomes
 * `structuredContent`, and how the two are told apart.
 *
 * Output validation itself belongs to the SDK — these assert what ViteMCP hands
 * it, including the cases where the wrong choice is only visible as a
 * downstream validation error.
 */
import { expect, test } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

type CallToolResult = {
  content: { text?: string; type: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};

/** Registers a single no-argument tool and calls it. */
const callTool = async ({
  execute,
  outputSchema,
}: {
  execute: () => unknown;
  outputSchema?: z.ZodType;
}): Promise<CallToolResult> => {
  let result: CallToolResult | undefined;

  await runWithTestServer({
    run: async ({ client }) => {
      result = (await client.callTool({
        arguments: {},
        name: "t",
      })) as CallToolResult;
    },
    server: async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });

      server.addTool({
        execute: execute as never,
        name: "t",
        ...(outputSchema ? { outputSchema } : {}),
        parameters: z.object({}),
      });

      return server;
    },
  });

  return result!;
};

test("returns structuredContent for a plain object payload", async () => {
  const result = await callTool({
    execute: () => ({ humidity: 41, temperature: 72 }),
    outputSchema: z.object({ humidity: z.number(), temperature: z.number() }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41, temperature: 72 });
  expect(result.content).toEqual([
    { text: JSON.stringify({ humidity: 41, temperature: 72 }), type: "text" },
  ]);
  expect(result.isError).toBeUndefined();
});

// Subsumed by the plain-payload case above — kept because it is the exact
// repro from the upstream report (fastmcp#315), and a named bug earns a test
// that fails if anyone reintroduces it.
test("returns structuredContent when the payload has a top-level `type`", async () => {
  const result = await callTool({
    execute: () => ({ temperature: 72, type: "sunny" }),
    outputSchema: z.object({ temperature: z.number(), type: z.string() }),
  });

  expect(result.structuredContent).toEqual({ temperature: 72, type: "sunny" });
  expect(result.isError).toBeUndefined();
});

test("returns structuredContent when `type` collides with a content block kind", async () => {
  const result = await callTool({
    execute: () => ({ size: 3, type: "text" }),
    outputSchema: z.object({
      size: z.number(),
      type: z.enum(["image", "text"]),
    }),
  });

  expect(result.structuredContent).toEqual({ size: 3, type: "text" });
  expect(result.content).toEqual([
    { text: JSON.stringify({ size: 3, type: "text" }), type: "text" },
  ]);
  expect(result.isError).toBeUndefined();
});

test("keeps the content shorthand for a tool without an outputSchema", async () => {
  const result = await callTool({
    execute: () => ({ text: "hello", type: "text" }),
  });

  expect(result.content).toEqual([{ text: "hello", type: "text" }]);
  expect(result.structuredContent).toBeUndefined();
});

test("passes an explicit content result through untouched", async () => {
  const result = await callTool({
    execute: () => ({
      content: [{ text: "rendered", type: "text" }],
      structuredContent: { temperature: 72 },
    }),
    outputSchema: z.object({ temperature: z.number() }),
  });

  expect(result.content).toEqual([{ text: "rendered", type: "text" }]);
  expect(result.structuredContent).toEqual({ temperature: 72 });
  expect(result.isError).toBeUndefined();
});

test("writes the text fallback for a bare structuredContent return", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: { humidity: 41 } }),
    outputSchema: z.object({ humidity: z.number() }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41 });
  expect(result.content).toEqual([
    { text: JSON.stringify({ humidity: 41 }), type: "text" },
  ]);
  expect(result.isError).toBeUndefined();
});

test("writes the text fallback without an outputSchema too", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: { humidity: 41 } }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41 });
  expect(result.content).toEqual([
    { text: JSON.stringify({ humidity: 41 }), type: "text" },
  ]);
});

test("carries _meta alongside a bare structuredContent return", async () => {
  const result = await callTool({
    execute: () => ({
      _meta: { "example.com/trace": "abc" },
      structuredContent: { humidity: 41 },
    }),
    outputSchema: z.object({ humidity: z.number() }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41 });
  expect(result.isError).toBeUndefined();
  expect((result as { _meta?: Record<string, unknown> })._meta).toMatchObject({
    "example.com/trace": "abc",
  });
});

test("carries isError alongside a bare structuredContent return", async () => {
  const result = await callTool({
    execute: () => ({ isError: true, structuredContent: { humidity: 41 } }),
    outputSchema: z.object({ humidity: z.number() }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41 });
  expect(result.isError).toBe(true);
});

test("serializes a null structuredContent rather than dropping the block", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: null }),
  });

  expect(result.content).toEqual([{ text: "null", type: "text" }]);
  expect(result.structuredContent).toBeNull();
});

// `find`/`get` returning nothing is the ordinary way to land here, and an
// unserializable text block would fail the call itself rather than the tool.
test("treats an undefined structuredContent as a plain payload", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: undefined }),
  });

  expect(result.content).toEqual([{ text: "{}", type: "text" }]);
  expect(result.structuredContent).toEqual({});
});

// A key of its own makes this a payload that has a `structuredContent` field,
// not a nomination — so the key belongs inside `structuredContent`, never
// beside it in the envelope, where it would reach the client unasked.
test("never lifts a tool's own keys into the result envelope", async () => {
  const payload = {
    internalToken: "SECRET",
    structuredContent: { humidity: 41 },
  };

  const result = await callTool({
    execute: () => payload,
    outputSchema: z.object({
      internalToken: z.string(),
      structuredContent: z.object({ humidity: z.number() }),
    }),
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual(payload);
  expect(result).not.toHaveProperty("internalToken");
});

// The conditional-key idiom. `trace` never reaches the wire either way, so it
// cannot be what decides whether this is a wrapper.
test("stays a wrapper when an extra key carries no value", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: { humidity: 41 }, trace: undefined }),
    outputSchema: z.object({ humidity: z.number() }),
  });

  expect(result.structuredContent).toEqual({ humidity: 41 });
  expect(result).not.toHaveProperty("trace");
});

// Both companions are copied into the envelope verbatim, so a wrongly typed one
// would fail the call itself rather than the tool. Reading the object as a
// payload keeps the damage to a tool error.
test("declines the wrapper when isError is not a boolean", async () => {
  const result = await callTool({
    execute: () => ({ isError: "yes", structuredContent: { humidity: 41 } }),
  });

  expect(result.structuredContent).toEqual({
    isError: "yes",
    structuredContent: { humidity: 41 },
  });
});

test("declines the wrapper when _meta is not an object", async () => {
  const result = await callTool({
    execute: () => ({ _meta: "nope", structuredContent: { humidity: 41 } }),
  });

  expect(result.structuredContent).toEqual({
    _meta: "nope",
    structuredContent: { humidity: 41 },
  });
});

test("emits a serializable block for a structuredContent JSON cannot represent", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: () => "not data" }),
  });

  expect(result.content).toEqual([{ text: "null", type: "text" }]);
});

test("reports an unserializable structuredContent as a tool error", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: { size: 1n } }),
  });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("BigInt");
});

test("treats a payload with its own structuredContent field as a payload", async () => {
  const result = await callTool({
    execute: () => ({ structuredContent: "abc", title: "Doc" }),
    outputSchema: z.object({
      structuredContent: z.string(),
      title: z.string(),
    }),
  });

  expect(result.structuredContent).toEqual({
    structuredContent: "abc",
    title: "Doc",
  });
  expect(result.isError).toBeUndefined();
});

test("ignores an inherited structuredContent", async () => {
  const result = await callTool({
    execute: () => Object.create({ structuredContent: { humidity: 41 } }),
  });

  expect(result.structuredContent).toEqual({});
});

test("resolves an array-valued `content` payload via structuredContent", async () => {
  const payload = { content: ["para one", "para two"], title: "Doc" };

  // Returned bare, the array reads as content blocks — the ambiguity that
  // cannot be settled by inspection, and the reason for the escape hatch.
  const guessed = await callTool({
    execute: () => payload,
    outputSchema: z.object({
      content: z.array(z.string()),
      title: z.string(),
    }),
  });

  expect(guessed.isError).toBe(true);
  expect(guessed.structuredContent).toBeUndefined();

  const stated = await callTool({
    execute: () => ({ structuredContent: payload }),
    outputSchema: z.object({
      content: z.array(z.string()),
      title: z.string(),
    }),
  });

  expect(stated.structuredContent).toEqual(payload);
  expect(stated.isError).toBeUndefined();
});

test("returns empty content for a void tool", async () => {
  const result = await callTool({ execute: () => undefined });

  expect(result.content).toEqual([]);
  expect(result.structuredContent).toBeUndefined();
});

test("wraps a string return as text content", async () => {
  const result = await callTool({ execute: () => "plain" });

  expect(result.content).toEqual([{ text: "plain", type: "text" }]);
  expect(result.structuredContent).toBeUndefined();
});
