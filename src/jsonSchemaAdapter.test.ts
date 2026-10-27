import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test, vi } from "vitest";
import { toJsonSchema } from "xsschema";

import {
  jsonSchemaAdapter,
  type JsonSchemaObject,
} from "./jsonSchemaAdapter.js";
import { ViteMCP } from "./ViteMCP.js";

const personSchema = {
  properties: {
    age: { type: "number" },
    name: { type: "string" },
  },
  required: ["name"],
  type: "object",
};

test("accepts input matching the schema", async () => {
  const schema = jsonSchemaAdapter({ ...personSchema });

  const result = await schema["~standard"].validate({ age: 30, name: "Alice" });

  expect(result.issues).toBeUndefined();
  expect(result.issues === undefined && result.value).toEqual({
    age: 30,
    name: "Alice",
  });
});

test("reports issues for input that does not match", async () => {
  const schema = jsonSchemaAdapter({ ...personSchema });

  const result = await schema["~standard"].validate({ age: "not a number" });

  expect(result.issues?.length).toBeGreaterThan(0);
});

test("points a missing-property issue at the missing field", async () => {
  const schema = jsonSchemaAdapter({ ...personSchema });

  const result = await schema["~standard"].validate({ age: 30 });

  // AJV reports `required` against the parent object, so without fixing up the
  // path the issue would point at the root and say nothing about which field.
  expect(result.issues?.map((issue) => issue.path)).toContainEqual(["name"]);
});

test("reports paths into nested objects and arrays", async () => {
  const schema = jsonSchemaAdapter({
    properties: {
      contacts: {
        items: {
          properties: { email: { type: "string" } },
          required: ["email"],
          type: "object",
        },
        type: "array",
      },
    },
    required: ["contacts"],
    type: "object",
  });

  const result = await schema["~standard"].validate({
    contacts: [{ email: "a@example.com" }, { email: 42 }],
  });

  // Array indices come back as numbers, not as the strings AJV puts in its
  // JSON Pointer.
  expect(result.issues?.map((issue) => issue.path)).toContainEqual([
    "contacts",
    1,
    "email",
  ]);
});

test("preserves non-canonical numeric object keys in issue paths", async () => {
  const numericObjectKeys = ["01", "-1", "1.0", "9007199254740993"];
  const schema = jsonSchemaAdapter({
    properties: Object.fromEntries(
      numericObjectKeys.map((key) => [key, { type: "number" }]),
    ),
    required: numericObjectKeys,
    type: "object",
  });

  const result = await schema["~standard"].validate(
    Object.fromEntries(numericObjectKeys.map((key) => [key, "not a number"])),
  );

  expect(result.issues?.map((issue) => issue.path)).toEqual(
    numericObjectKeys.map((key) => [key]),
  );
});

test.each([
  { input: null, name: "the document root", path: [] },
  { input: { "": 42 }, name: "an empty property name", path: [""] },
  {
    input: { "": [{ "a/b": "not a number" }] },
    name: "an array item under an empty property name",
    path: ["", 0, "a/b"],
  },
  {
    input: { "": [{}] },
    name: "a missing property under an empty property name",
    path: ["", 0, "a/b"],
  },
])("preserves issue paths for $name", async ({ input, path }) => {
  const schema = jsonSchemaAdapter({
    properties: {
      "": {
        items: {
          properties: { "a/b": { type: "number" } },
          required: ["a/b"],
          type: "object",
        },
        type: "array",
      },
    },
    type: "object",
  });

  const result = await schema["~standard"].validate(input);

  // An empty property name is an empty JSON Pointer segment, not a separator:
  // dropping it would point the issue at the root, or at the wrong parent.
  expect(result.issues?.map((issue) => issue.path)).toEqual([path]);
});

test("validates nested objects", async () => {
  const schema = jsonSchemaAdapter({
    properties: {
      address: {
        properties: {
          street: { type: "string" },
          zip: { type: "string" },
        },
        required: ["street"],
        type: "object",
      },
    },
    required: ["address"],
    type: "object",
  });

  const valid = await schema["~standard"].validate({
    address: { street: "123 Main St", zip: "12345" },
  });
  expect(valid.issues).toBeUndefined();

  const invalid = await schema["~standard"].validate({
    address: { zip: "12345" },
  });
  expect(invalid.issues?.length).toBeGreaterThan(0);
});

test("takes a schema for additionalProperties, as a dictionary is written", async () => {
  // Typed, rather than inferred, so the type accepts a schema here: it took
  // only a boolean, and a dictionary could not be written without a cast.
  const dictionary: JsonSchemaObject = {
    additionalProperties: { type: "string" },
    type: "object",
  };
  const schema = jsonSchemaAdapter(dictionary);

  expect(
    (await schema["~standard"].validate({ team: "infra" })).issues,
  ).toBeUndefined();
  expect((await schema["~standard"].validate({ team: 42 })).issues).toEqual([
    { message: "must be string", path: ["team"] },
  ]);
  await expect(toJsonSchema(schema)).resolves.toEqual(dictionary);
});

// A 2020-12 tuple: two items, a string then a number, and no more.
const pairSchema = {
  properties: {
    pair: {
      items: false,
      prefixItems: [{ type: "string" }, { type: "number" }],
      type: "array",
    },
  },
  required: ["pair"],
  type: "object",
};

test.each([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
  "http://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema#",
])("validates a schema declaring 2020-12 (%s)", async ($schema) => {
  const schema = jsonSchemaAdapter({
    ...pairSchema,
    $schema,
    unevaluatedProperties: false,
  });

  expect(
    (await schema["~standard"].validate({ pair: ["answer", 42] })).issues,
  ).toBeUndefined();

  for (const input of [
    { pair: [42, "answer"] },
    { pair: ["answer", 42, true] },
    { extra: true, pair: ["answer", 42] },
  ]) {
    expect(
      (await schema["~standard"].validate(input)).issues?.length,
    ).toBeGreaterThan(0);
  }

  // Advertised as written: `$schema` is dropped only from the compiled copy.
  await expect(toJsonSchema(schema)).resolves.toMatchObject({ $schema });
});

test("validates a schema declaring no dialect as 2020-12, as clients read it", async () => {
  const schema = jsonSchemaAdapter({ ...pairSchema });

  // Draft-07 knows no `prefixItems`, and read `items: false` as "no items".
  expect(
    (await schema["~standard"].validate({ pair: ["answer", 42] })).issues,
  ).toBeUndefined();
  expect(
    (await schema["~standard"].validate({ pair: ["answer", 42, true] })).issues,
  ).toEqual([{ message: "must NOT have more than 2 items", path: ["pair"] }]);
});

test.each([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-06/schema#",
])("validates a schema declaring %s as draft-07", async ($schema) => {
  const schema = jsonSchemaAdapter({
    $schema,
    properties: {
      pair: {
        additionalItems: false,
        items: [{ type: "string" }, { type: "number" }],
        type: "array",
      },
    },
    required: ["pair"],
    type: "object",
  });

  expect(
    (await schema["~standard"].validate({ pair: ["answer", 42] })).issues,
  ).toBeUndefined();
  expect(
    (await schema["~standard"].validate({ pair: ["answer", 42, true] })).issues
      ?.length,
  ).toBeGreaterThan(0);
});

test("validates a schema declaring 2019-09", async () => {
  const schema = jsonSchemaAdapter({
    $schema: "https://json-schema.org/draft/2019-09/schema",
    allOf: [{ properties: { name: { type: "string" } } }],
    type: "object",
    unevaluatedProperties: false,
  });

  expect(
    (await schema["~standard"].validate({ name: "Alice" })).issues,
  ).toBeUndefined();
  expect(
    (await schema["~standard"].validate({ age: 30, name: "Alice" })).issues
      ?.length,
  ).toBeGreaterThan(0);
});

test("names the dialects it supports when a schema declares another", async () => {
  const schema = jsonSchemaAdapter({
    ...personSchema,
    $schema: "http://json-schema.org/draft-04/schema#",
  });

  await expect(schema["~standard"].validate({ name: "Alice" })).rejects.toThrow(
    "validates 2020-12, 2019-09, draft-07 and draft-06",
  );
});

test("counts only the data's own keys as present", async () => {
  const schema = jsonSchemaAdapter({
    properties: {
      constructor: { type: "string" },
      toString: { type: "string" },
      valueOf: { type: "string" },
    },
    required: ["valueOf"],
    type: "object",
  });

  const result = await schema["~standard"].validate({});

  // `constructor` and `toString` may be left out, and `valueOf` is missing,
  // not the function `Object.prototype` has under that name.
  expect(result.issues).toEqual([
    { message: "must have required property 'valueOf'", path: ["valueOf"] },
  ]);
});

test("enforces format keywords when ajv-formats is installed", async () => {
  const schema = jsonSchemaAdapter({
    properties: { email: { format: "email", type: "string" } },
    required: ["email"],
    type: "object",
  });

  const valid = await schema["~standard"].validate({
    email: "user@example.com",
  });
  expect(valid.issues).toBeUndefined();

  const invalid = await schema["~standard"].validate({ email: "not-an-email" });
  expect(invalid.issues?.length).toBeGreaterThan(0);
});

test("compiles the schema once across many validations", async () => {
  let compileCount = 0;

  const counted = new Proxy({ ...personSchema } as Record<string, unknown>, {
    ownKeys(target) {
      // AJV reads the schema's keys while compiling, so this counts
      // compilations without reaching into AJV internals.
      compileCount++;
      return Reflect.ownKeys(target);
    },
  });

  const schema = jsonSchemaAdapter(
    counted as unknown as { type: string } & Record<string, unknown>,
  );

  await Promise.all(
    Array.from({ length: 5 }, () =>
      schema["~standard"].validate({ name: "Alice" }),
    ),
  );
  await schema["~standard"].validate({ name: "Bob" });

  const afterFirstBatch = compileCount;

  await schema["~standard"].validate({ name: "Carol" });

  // Whatever AJV reads during compilation, it must not read it again.
  expect(compileCount).toBe(afterFirstBatch);
  expect(compileCount).toBeGreaterThan(0);
});

test("converts to JSON Schema without a vendor-specific converter", async () => {
  const schema = jsonSchemaAdapter({ ...personSchema });

  // xsschema has no "json-schema" vendor; it has to take the schema straight
  // off `~standard.jsonSchema` instead. This is what lets the adapter work for
  // both parameters and outputSchema with no special-casing in ViteMCP.
  await expect(toJsonSchema(schema)).resolves.toEqual(personSchema);
});

/** Starts a server exposing one JSON Schema tool and connects a client to it. */
const withGreetServer = async (
  run: (client: Client) => Promise<void>,
): Promise<void> => {
  const server = new ViteMCP({ name: "Test server", version: "1.0.0" });

  server.addTool({
    description: "Greet a user",
    // The tool declares an outputSchema, so it must return matching
    // structured content — v2 enforces the contract the tool advertises.
    execute: async (args) => ({
      greeting: `Hello, ${(args as { name: string }).name}!`,
    }),
    name: "greet",
    outputSchema: jsonSchemaAdapter({
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
      type: "object",
    }),
    parameters: jsonSchemaAdapter({ ...personSchema }),
  });

  await server.start({ httpStream: { port: 0 }, transportType: "httpStream" });

  const port = server.port!;
  const client = new Client(
    { name: "Test client", version: "1.0.0" },
    // Without this the SDK client negotiates the 2025 era, which this
    // modern-only server rejects.
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
      ),
    );
    await run(client);
    await client.close();
  } finally {
    await server.stop();
  }
};

test("advertises the schema through tools/list as written", async () => {
  await withGreetServer(async (client) => {
    const { tools } = await client.listTools();
    const greet = tools.find((tool) => tool.name === "greet");

    // The adapter carries its own JSON Schema, so it passes through untouched,
    // as Zod and ArkType schemas do — only schemas that must be converted get
    // closed with additionalProperties: false.
    expect(greet?.inputSchema).toEqual({
      properties: {
        age: { type: "number" },
        name: { type: "string" },
      },
      required: ["name"],
      type: "object",
    });

    // outputSchema passes through the same way; xsschema, which has no
    // converter for the "json-schema" vendor, is never asked.
    expect(greet?.outputSchema).toMatchObject({
      required: ["greeting"],
    });
  });
});

test("rejects a tool call whose arguments do not match", async () => {
  await withGreetServer(async (client) => {
    // The issue path fix is what puts "name:" in front of the message; without
    // it the client is told a property is missing but not which one.
    // v2 surfaces schema violations as an error result rather than a rejection.
    const rejected = await client.callTool({
      arguments: { age: 30 },
      name: "greet",
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toMatch(
      /must have required property 'name'/,
    );

    const accepted = await client.callTool({
      arguments: { name: "Alice" },
      name: "greet",
    });
    expect(accepted.structuredContent).toEqual({ greeting: "Hello, Alice!" });
    expect(accepted.content).toMatchObject([
      { text: JSON.stringify({ greeting: "Hello, Alice!" }), type: "text" },
    ]);
  });
});

// Each dialect's engine is a module of its own, and each has to be reported.
test.each([
  { $schema: undefined, module: "ajv/dist/2020.js" },
  {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    module: "ajv/dist/2019.js",
  },
  { $schema: "http://json-schema.org/draft-07/schema#", module: "ajv" },
])(
  "explains what to install when $module is missing",
  async ({ $schema, module }) => {
    vi.doMock(module, () => {
      throw new Error(`Cannot find module '${module}'`);
    });
    vi.resetModules();

    const { jsonSchemaAdapter: freshAdapter } =
      await import("./jsonSchemaAdapter.js");
    const schema = freshAdapter({ ...personSchema, $schema });

    await expect(
      schema["~standard"].validate({ name: "Alice" }),
    ).rejects.toThrow(/npm install ajv/);

    // The failure is not cached, so installing ajv and retrying works without
    // rebuilding the schema.
    await expect(
      schema["~standard"].validate({ name: "Alice" }),
    ).rejects.toThrow(/npm install ajv/);

    vi.doUnmock(module);
    vi.resetModules();
  },
);
