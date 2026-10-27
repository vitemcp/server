import { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * A plain JSON Schema object descriptor.
 */
export type JsonSchemaObject = {
  [key: string]: unknown;
  $schema?: string;
  additionalProperties?: boolean | Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: string[];
  type: string;
};

/**
 * A Standard Schema that also carries the JSON Schema it was built from.
 *
 * `~standard.jsonSchema` is the Standard JSON Schema extension. Anything that
 * knows about it — including the `xsschema` conversion ViteMCP uses to build
 * `tools/list` — reads the schema straight off the object instead of trying to
 * derive one from a validation library it does not recognise.
 */
export interface JsonSchemaStandardSchema extends StandardSchemaV1 {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: () => JsonSchemaObject;
      readonly output: () => JsonSchemaObject;
    };
  } & StandardSchemaV1.Props;
}

interface AjvErrorObject {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
}

type AjvValidateFunction = {
  errors?: AjvErrorObject[] | null;
  (data: unknown): boolean;
};

/**
 * Wraps a plain JSON Schema object for use as a tool's `parameters` or
 * `outputSchema`, without pulling in Zod or Valibot.
 *
 * Validation uses AJV, an optional peer dependency — install `ajv` (plus
 * `ajv-formats` for `format` keywords). It is imported on first validation, so
 * servers that never call it pay nothing.
 *
 * @example
 * ```ts
 * server.addTool({
 *   name: "greet",
 *   parameters: jsonSchemaAdapter({
 *     type: "object",
 *     properties: { name: { type: "string" } },
 *     required: ["name"],
 *   }),
 *   execute: async ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 */
export function jsonSchemaAdapter(
  schema: JsonSchemaObject,
): JsonSchemaStandardSchema {
  // Compiling a schema makes AJV generate and evaluate JavaScript, so it has
  // to happen once rather than per call. The promise is memoised, not just the
  // result, so concurrent first calls share a single compilation.
  let compiled: Promise<AjvValidateFunction> | undefined;

  const getValidator = (): Promise<AjvValidateFunction> => {
    compiled ??= compileSchema(schema).catch((error: unknown) => {
      // Do not memoise a failure: a missing dependency should be reported on
      // every call, not swallowed after the first.
      compiled = undefined;
      throw error;
    });

    return compiled;
  };

  return {
    "~standard": {
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
      validate: async (
        data: unknown,
      ): Promise<StandardSchemaV1.Result<unknown>> => {
        const validate = await getValidator();

        if (validate(data)) {
          return { value: data };
        }

        return { issues: (validate.errors ?? []).map(toIssue) };
      },
      vendor: "json-schema",
      version: 1,
    },
  };
}

/**
 * The JSON Schema dialect a schema is validated in, read from its `$schema` as
 * the MCP SDK reads it: 2020-12 when there is none (SEP-1613), and draft-07 for
 * draft-06, which draft-07 only added to.
 *
 * Clients validate structured content in that dialect, so validating in
 * another has the two disagree. AJV's default engine is draft-07's, which read
 * 2020-12's `items: false` beside `prefixItems` as "no items at all", and
 * failed to compile a schema declaring 2020-12.
 */
const dialectOf = ($schema: unknown): "2019-09" | "2020-12" | "draft-07" => {
  if (typeof $schema !== "string") {
    return "2020-12";
  }

  switch ($schema.replace(/^https?:\/\//, "").replace(/#$/, "")) {
    case "json-schema.org/draft-06/schema":
    case "json-schema.org/draft-07/schema":
      return "draft-07";
    case "json-schema.org/draft/2019-09/schema":
      return "2019-09";
    case "json-schema.org/draft/2020-12/schema":
      return "2020-12";
  }

  throw new Error(
    `JSON Schema declares an unsupported dialect ("$schema": "${$schema}"). ` +
      "jsonSchemaAdapter validates 2020-12, 2019-09, draft-07 and draft-06.",
  );
};

async function compileSchema(
  schema: JsonSchemaObject,
): Promise<AjvValidateFunction> {
  // `$schema` picks the engine, and the engine checks the schema against its
  // own dialect's meta-schema. Left in, `$schema` would have to use the scheme
  // AJV registered that meta-schema under — `http:` for draft-07, `https:` for
  // the rest — or compiling fails as "no schema with key or ref". What is
  // advertised is `schema`, `$schema` and all.
  const { $schema, ...body } = schema;
  const dialect = dialectOf($schema);
  let ajvModule;

  try {
    ajvModule =
      dialect === "2020-12"
        ? await import("ajv/dist/2020.js")
        : dialect === "2019-09"
          ? await import("ajv/dist/2019.js")
          : await import("ajv");
  } catch {
    throw new Error(
      'The "ajv" package is required to validate JSON Schema tool parameters. ' +
        "Install it with: npm install ajv",
    );
  }

  // ajv ships CommonJS, so depending on the loader the class arrives as the
  // module namespace, as `.default`, or as `.default.default`.
  const Ajv = unwrapDefault(unwrapDefault(ajvModule)) as unknown as new (
    options: Record<string, unknown>,
  ) => {
    compile: (schema: unknown) => AjvValidateFunction;
  };

  // A key counts as present only if the data has it of its own. AJV otherwise
  // reads `data[key]`, which finds `Object.prototype`'s members, so leaving
  // out an optional `toString` or `constructor` failed as "must be string".
  const ajv = new Ajv({ allErrors: true, ownProperties: true, strict: false });

  try {
    const formatsModule = await import("ajv-formats");
    const addFormats = unwrapDefault(
      unwrapDefault(formatsModule),
    ) as unknown as (ajv: unknown) => void;

    addFormats(ajv);
  } catch {
    // ajv-formats is optional; `format` keywords are simply not enforced.
  }

  return ajv.compile(body);
}

function toIssue(error: AjvErrorObject): StandardSchemaV1.Issue {
  // Only the first split element is the empty string before the leading `/`.
  // Any other empty segment is a property named "", which is a legal key.
  const path = error.instancePath
    .split("/")
    .slice(1)
    // JSON Pointer escapes, per RFC 6901.
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment): number | string => {
      const index = Number(segment);
      return /^(?:0|[1-9]\d*)$/.test(segment) && Number.isSafeInteger(index)
        ? index
        : segment;
    });

  // AJV reports a missing property against its parent object, with the name in
  // `params`. Appending it points the issue at the field the user has to fix.
  const missingProperty = error.params?.missingProperty;

  if (error.keyword === "required" && typeof missingProperty === "string") {
    path.push(missingProperty);
  }

  return {
    message: error.message || "Validation error",
    path,
  };
}

function unwrapDefault(value: unknown): unknown {
  return typeof value === "object" && value !== null && "default" in value
    ? (value as { default: unknown }).default
    : value;
}
