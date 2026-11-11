import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonSchema } from "xsschema";

import { withOwnKeysOnly } from "./ownKeysOnly.js";

/**
 * Turns a Standard Schema that carries no JSON Schema into one. Which
 * libraries that can be done for depends on the runtime, so each entry point
 * supplies its own.
 */
export type JsonSchemaConverter = (
  schema: StandardSchemaV1,
  io: "input" | "output",
) => Promise<JsonSchema>;

/**
 * `~standard.jsonSchema`, as Zod v4 and ArkType implement it. Declared here
 * because `@standard-schema/spec` 1.0 predates it.
 */
type NativeJsonSchema = Record<
  "input" | "output",
  (options: {
    libraryOptions?: Record<string, unknown>;
    target: string;
  }) => JsonSchema
>;

/** The draft the SDK asks a schema for when `tools/list` describes a tool. */
const SDK_TARGET = "draft-2020-12";

/**
 * What a library is told so that it leaves open the parts of a schema JSON
 * Schema cannot say, rather than refuse the schema over them. Zod describes
 * such a part as `{}`. ArkType hands over what it had worked out before it
 * reached the part: `{}` for a `Date`, `{ type: "string" }` for a string under
 * a `narrow()`.
 *
 * A library not named here is left to refuse, and its tool is not served.
 */
const LENIENT_OPTIONS = new Map<string, Record<string, unknown>>([
  ["arktype", { fallback: (context: { base: JsonSchema }) => context.base }],
  ["zod", { unrepresentable: "any" }],
]);

/**
 * A tool's schema as the SDK registers it: one that validates by own keys only
 * (see `withOwnKeysOnly`) and carries a JSON Schema. The schema itself is left
 * as it was, since whoever wrote it may use it elsewhere.
 *
 * Zod v4 and ArkType emit JSON Schema natively, and theirs is kept; anything
 * else (Valibot, say) is converted, and the conversion is only what
 * `tools/list` advertises. Validation stays with the library the schema was
 * written in: the conversion drops what JSON Schema cannot say — a transform,
 * a `check()` — so validating against it instead would pass `execute`
 * arguments the schema never produced.
 *
 * A native schema is converted here too, once, the way the SDK will for
 * `tools/list`. The SDK converts every tool in the one handler, so a schema
 * its library refused to convert — a `z.date()`, a `z.bigint()`, an ArkType
 * `narrow()` — failed the list for every tool, though each could still be
 * called. One refused is asked for again with what JSON Schema cannot say left
 * open (see `LENIENT_OPTIONS`), which is what Valibot's converter is already
 * told, and that copy is advertised in place of the library's own.
 *
 * Converted inputs are closed with `strictInputSchema`. Outputs are left as
 * converted, since closing them would misdescribe results the schema allows.
 *
 * Shared by `ViteMCP` and `EdgeViteMCP`, so what a tool advertises does not
 * depend on which of them serves it. Rejects when `convert` does, when a
 * library refuses a schema even leniently, and for an input schema that does
 * not describe an object: each caller leaves that tool out and serves the rest.
 */
export const toSdkSchema = async (
  schema: unknown,
  io: "input" | "output",
  convert: JsonSchemaConverter,
): Promise<unknown> => {
  if (!schema) {
    return undefined;
  }

  const standard = withOwnKeysOnly(
    (
      schema as {
        "~standard": {
          jsonSchema?: NativeJsonSchema;
        } & StandardSchemaV1.Props;
      }
    )["~standard"],
  );

  if (standard.jsonSchema) {
    const { json, lenient } = nativeJsonSchema(
      standard.jsonSchema,
      standard.vendor,
      io,
    );

    assertDescribesArguments(json, io);

    return lenient ? advertising(standard, json) : { "~standard": standard };
  }

  const json = await convert(schema as StandardSchemaV1, io);

  assertDescribesArguments(json, io);

  return advertising(standard, io === "input" ? strictInputSchema(json) : json);
};

/**
 * JSON Schema for a Valibot schema, for advertising.
 *
 * Valibot's converter is called directly so it can be told to skip what JSON
 * Schema cannot express — a transform, a `check()` — rather than refuse the
 * whole schema. Valibot still validates, so the copy only has to describe what
 * a caller sends (`typeMode: "input"`, which stops at the first transform) or
 * receives (`"output"`).
 *
 * The `import()` has to stay inside the `try`. An edge bundle is built with
 * every import resolved ahead of time, and a bundler fails the build over one
 * it cannot resolve — unless it can see the failure is handled, in which case
 * a server that never touches Valibot builds without the converter installed.
 */
export const valibotToJsonSchema: JsonSchemaConverter = async (schema, io) => {
  let converter;

  try {
    converter = await import("@valibot/to-json-schema");
  } catch {
    throw new Error(
      'The "@valibot/to-json-schema" package is required to describe Valibot ' +
        "schemas. Install it with: npm install @valibot/to-json-schema",
    );
  }

  return converter.toJsonSchema(schema as never, {
    errorMode: "ignore",
    typeMode: io,
  }) as JsonSchema;
};

/** `standard`, carrying `advertised` as its JSON Schema, input and output. */
const advertising = <P extends StandardSchemaV1.Props>(
  standard: P,
  advertised: JsonSchema,
) => ({
  "~standard": {
    ...standard,
    jsonSchema: { input: () => advertised, output: () => advertised },
  },
});

/**
 * Refuses an input schema that describes anything but an object. A tool's
 * arguments are always one, and the SDK will not list a schema that says
 * otherwise: `parameters: z.string()` failed `tools/list` for every tool, as an
 * unconvertible schema did.
 */
const assertDescribesArguments = (
  json: JsonSchema,
  io: "input" | "output",
): void => {
  if (io === "input" && json.type !== undefined && json.type !== "object") {
    throw new Error(
      `A tool's arguments are an object, and this schema describes ${JSON.stringify(
        json.type,
      )}. Wrap it in an object schema.`,
    );
  }
};

/**
 * A schema's own JSON Schema, and whether it had to be asked for leniently.
 * Throws what the library does when it refuses the schema either way.
 */
const nativeJsonSchema = (
  native: NativeJsonSchema,
  vendor: string,
  io: "input" | "output",
): { json: JsonSchema; lenient: boolean } => {
  try {
    return { json: native[io]({ target: SDK_TARGET }), lenient: false };
  } catch (error) {
    const libraryOptions = LENIENT_OPTIONS.get(vendor);

    if (!libraryOptions) {
      throw error;
    }

    return {
      json: native[io]({ libraryOptions, target: SDK_TARGET }),
      lenient: true,
    };
  }
};

/**
 * Closes an advertised input schema's objects to undeclared keys, except where
 * the schema describes those keys itself. A record's value schema, or an
 * object's rest schema, arrives as `additionalProperties`; replacing it with
 * `false` would tell clients the tool takes none of those keys, so a
 * `v.record()` argument could only ever be sent as `{}`.
 *
 * Nor is an object closed whose keys are declared elsewhere: in its `allOf`,
 * `anyOf` or `oneOf` branches — a `v.intersect()`, `v.union()` or
 * `v.variant()` — or behind a `$ref`, which is how a `v.lazy()` arrives.
 * `additionalProperties` sees only the `properties` beside it, so closing one
 * refused every key declared elsewhere, and every argument with them.
 */
const strictInputSchema = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  ...(!(schema.allOf ?? schema.anyOf ?? schema.oneOf ?? schema.$ref) && {
    additionalProperties:
      typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : false,
  }),
  ...(schema.properties && {
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        typeof value === "object" && value.type === "object"
          ? strictInputSchema(value)
          : value,
      ]),
    ),
  }),
});
