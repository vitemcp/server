import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonSchema } from "xsschema";

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
 * Gives the SDK a JSON Schema for a schema that has none of its own. Zod v4
 * and ArkType emit JSON Schema natively and pass through; anything else
 * (Valibot, say) is converted, and the conversion is only what `tools/list`
 * advertises. Validation stays with the library the schema was written in:
 * the conversion drops what JSON Schema cannot say — a transform, a
 * `check()` — so validating against it instead would pass `execute`
 * arguments the schema never produced.
 *
 * Advertised inputs are closed with `strictInputSchema`. Outputs are left as
 * converted, since closing them would misdescribe results the schema allows.
 *
 * Shared by `ViteMCP` and `EdgeViteMCP`, so what a tool advertises does not
 * depend on which of them serves it. Rejects when `convert` does.
 */
export const toSdkSchema = async (
  schema: unknown,
  io: "input" | "output",
  convert: JsonSchemaConverter,
): Promise<unknown> => {
  if (!schema) {
    return undefined;
  }

  const standard = (
    schema as {
      "~standard": { jsonSchema?: unknown } & StandardSchemaV1.Props;
    }
  )["~standard"];

  if (standard.jsonSchema) {
    return schema;
  }

  const json = await convert(schema as StandardSchemaV1, io);
  const advertised = io === "input" ? strictInputSchema(json) : json;

  return {
    "~standard": {
      jsonSchema: { input: () => advertised, output: () => advertised },
      validate: (value: unknown) => standard.validate(value),
      vendor: standard.vendor,
      version: standard.version,
    },
  };
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

/**
 * Closes an advertised input schema's objects to undeclared keys, except where
 * the schema describes those keys itself. A record's value schema, or an
 * object's rest schema, arrives as `additionalProperties`; replacing it with
 * `false` would tell clients the tool takes none of those keys, so a
 * `v.record()` argument could only ever be sent as `{}`.
 */
const strictInputSchema = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  additionalProperties:
    typeof schema.additionalProperties === "object"
      ? schema.additionalProperties
      : false,
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
