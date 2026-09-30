import type { JsonSchemaObject } from "../jsonSchemaAdapter.js";
import type { SchemaNormalizer } from "./normalize.js";
import type { HttpRoute, OpenApiParameter, OpenApiSchema } from "./types.js";

import { collectDefinitions } from "./normalize.js";

/** Everything derived from one operation that building a request needs. */
export type ToolBinding = {
  /** How to encode the request body, when the operation takes one. */
  bodyEncoding?: BodyEncoding;
  /** A note about the operation, when part of it could not be modelled. */
  caveat?: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  /** Tool argument name to where it belongs in the request. */
  parameters: Record<string, ParameterBinding>;
  /**
   * Set when the body is exposed as one argument rather than flattened into
   * several — an array body, or one the schema describes as a scalar.
   */
  wholeBodyKey?: string;
};

type BodyEncoding = {
  contentType: string;
  kind: "form" | "json" | "text";
};

type ParameterBinding =
  | { kind: "body"; name: string }
  | { kind: "parameter"; parameter: OpenApiParameter };

/**
 * Flattens an operation's parameters and request body into the single object
 * schema an MCP tool takes, and records where each argument goes.
 *
 * Flattening is what makes these tools usable: a model filling one flat
 * argument list gets it right far more often than one asked to nest a body
 * under `body` and parameters under `params`. Names can collide across the
 * four parameter locations and the body, so a colliding parameter is suffixed
 * with its location (`id__query`) while a body property always keeps the bare
 * name — the body is the part a model is most likely to name correctly
 * unprompted.
 */
export const buildToolBinding = (
  route: HttpRoute,
  normalizer: SchemaNormalizer,
  withOutputSchema: boolean,
): ToolBinding => {
  const body = describeBody(route, normalizer);
  const properties: Record<string, OpenApiSchema> = {};
  const parameters: Record<string, ParameterBinding> = {};
  const required: string[] = [];

  const byName = new Map<string, OpenApiParameter[]>();

  for (const parameter of route.parameters) {
    byName.set(parameter.name, [
      ...(byName.get(parameter.name) ?? []),
      parameter,
    ]);
  }

  for (const [name, occurrences] of byName) {
    const collides = occurrences.length > 1 || body.properties.has(name);

    for (const parameter of occurrences) {
      const key = collides ? `${name}__${parameter.in}` : name;

      properties[key] = describeParameter(parameter, normalizer);
      parameters[key] = { kind: "parameter", parameter };

      // The specification makes a path parameter required whether or not it
      // says so, since the URL cannot be built without it.
      if (parameter.in === "path" || parameter.required) {
        required.push(key);
      }
    }
  }

  for (const [name, property] of body.properties) {
    properties[name] = property.schema;
    parameters[name] = { kind: "body", name };

    if (property.required) {
      required.push(name);
    }
  }

  const inputSchema: JsonSchemaObject = {
    additionalProperties: false,
    properties,
    type: "object",
    ...(required.length > 0 ? { required: required.sort() } : {}),
  };

  const definitions = collectDefinitions(properties, normalizer.definitions);

  if (definitions) {
    inputSchema.$defs = definitions;
  }

  return {
    bodyEncoding: body.encoding,
    caveat: body.caveat,
    inputSchema,
    outputSchema: withOutputSchema
      ? buildOutputSchema(route, normalizer)
      : undefined,
    parameters,
    wholeBodyKey: body.wholeBodyKey,
  };
};

type BodyProperty = { required: boolean; schema: OpenApiSchema };

type DescribedBody = {
  caveat?: string;
  encoding?: BodyEncoding;
  properties: Map<string, BodyProperty>;
  wholeBodyKey?: string;
};

/**
 * Picks the media type to send and turns its schema into tool arguments.
 *
 * `GET` is excluded outright. A body on a `GET` is legal in OpenAPI and
 * rejected by `fetch`, so a tool built from one would advertise arguments it
 * could never send; leaving them out states the limitation in the schema
 * instead of failing at call time.
 */
const describeBody = (
  route: HttpRoute,
  normalizer: SchemaNormalizer,
): DescribedBody => {
  const properties = new Map<string, BodyProperty>();
  const content =
    route.method === "get" ? undefined : route.requestBody?.content;

  if (!content || Object.keys(content).length === 0) {
    return { properties };
  }

  const contentType = selectContentType(Object.keys(content));

  if (!contentType) {
    return {
      caveat: `This operation sends a ${Object.keys(content).sort().join(" or ")} body, which this tool cannot construct.`,
      properties,
    };
  }

  const kind = encodingKindFor(contentType);
  const encoding = { contentType, kind };
  const required = route.requestBody?.required ?? false;
  const rawSchema = content[contentType]?.schema;
  const schema = rawSchema ? normalizer.normalize(rawSchema) : undefined;

  if (kind === "text") {
    properties.set("body", { required, schema: schema ?? { type: "string" } });
    return { encoding, properties, wholeBodyKey: "body" };
  }

  if (!schema) {
    return { encoding, properties };
  }

  const object = flattenObject(schema, normalizer.definitions);

  // An object that declares no properties is not one without a body: it is a
  // dictionary, whose keys are the caller's to choose, or an object that must
  // be sent empty. Flattened, either would leave the tool no argument to carry
  // it in. Generators write a dictionary exactly this way, with an empty
  // `properties` beside `additionalProperties`.
  if (object && Object.keys(object.properties).length > 0) {
    for (const [name, property] of Object.entries(object.properties)) {
      properties.set(name, {
        required: object.required.has(name),
        schema: property,
      });
    }

    return { encoding, properties };
  }

  // An array body, a dictionary, or one the document describes only by `$ref`
  // or a composition keyword: there is nothing to flatten, so the whole body
  // becomes one argument.
  properties.set("body", { required, schema });

  return { encoding, properties, wholeBodyKey: "body" };
};

/**
 * How many `$defs` one response schema may pull in before it is dropped.
 *
 * Response schemas reference the document's shared components far more freely
 * than request bodies do, and `tools/list` carries every tool's at once. On
 * Stripe's document the median operation reaches 868 definitions and roughly
 * 1MB, which is 362MB across the server — unsendable, and slow well before it
 * fails. The same document splits cleanly either side of this number: schemas
 * either stay under 50 definitions or jump past 500, nothing in between, so a
 * cap in that gap drops the runaway schemas and keeps every tractable one.
 */
const MAX_OUTPUT_SCHEMA_DEFINITIONS = 100;

/**
 * Derives a tool's `outputSchema` from its first successful JSON response.
 *
 * Only an object-typed response qualifies: MCP requires `structuredContent` to
 * be an object, so declaring an array or scalar schema would promise a shape
 * the protocol has no way to carry.
 */
const buildOutputSchema = (
  route: HttpRoute,
  normalizer: SchemaNormalizer,
): JsonSchemaObject | undefined => {
  const status = Object.keys(route.responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort()[0];

  const content = status ? route.responses[status]?.content : undefined;
  const contentType = content && findJsonContentType(Object.keys(content));
  const raw = contentType ? content?.[contentType]?.schema : undefined;

  if (!raw) {
    return undefined;
  }

  const schema = normalizer.normalize(raw);

  if (!resolvesToObject(schema, normalizer.definitions)) {
    return undefined;
  }

  const definitions = collectDefinitions(schema, normalizer.definitions);

  // Dropping the schema, rather than truncating its definitions, is what keeps
  // the result usable: a schema whose `$ref`s no longer resolve is worse than
  // no schema at all. The tool falls back to returning text, which is what it
  // does for every operation that declares no response schema.
  if (
    definitions &&
    Object.keys(definitions).length > MAX_OUTPUT_SCHEMA_DEFINITIONS
  ) {
    return undefined;
  }

  return {
    ...schema,
    type: "object",
    ...(definitions ? { $defs: definitions } : {}),
  } as JsonSchemaObject;
};

/**
 * A parameter's own `description` and `deprecated` live beside its schema
 * rather than inside it, so they have to be folded in here or they never reach
 * the model — and the description is the main thing it has to go on when
 * deciding what to put in the argument.
 */
const describeParameter = (
  parameter: OpenApiParameter,
  normalizer: SchemaNormalizer,
): OpenApiSchema => {
  const schema = normalizer.normalize(parameter.schema ?? { type: "string" });
  const description = [
    parameter.deprecated ? "Deprecated." : undefined,
    parameter.description ?? (schema.description as string | undefined),
  ]
    .filter(Boolean)
    .join(" ");

  return description ? { ...schema, description } : schema;
};

/**
 * Finds the properties of the object a body schema describes, following
 * `$ref`s and merging an `allOf` composition.
 *
 * Following the reference is what makes flattening work at all in practice:
 * almost every document defines its request bodies as a `$ref` to a named
 * component, and stopping at the reference would put the entire body behind a
 * single opaque argument.
 */
const flattenObject = (
  schema: OpenApiSchema | undefined,
  definitions: Record<string, OpenApiSchema>,
  depth = 0,
):
  | { properties: Record<string, OpenApiSchema>; required: Set<string> }
  | undefined => {
  if (!schema || depth > 8) {
    return undefined;
  }

  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
    return flattenObject(
      definitions[schema.$ref.slice("#/$defs/".length)],
      definitions,
      depth + 1,
    );
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const properties: Record<string, OpenApiSchema> = {};
    const required = new Set<string>();

    for (const branch of schema.allOf) {
      const part = flattenObject(
        branch as OpenApiSchema,
        definitions,
        depth + 1,
      );

      if (!part) {
        return undefined;
      }

      Object.assign(properties, part.properties);

      for (const name of part.required) {
        required.add(name);
      }
    }

    return { properties, required };
  }

  const properties = schema.properties;

  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return undefined;
  }

  return {
    properties: properties as Record<string, OpenApiSchema>,
    required: new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    ),
  };
};

const encodingKindFor = (contentType: string): BodyEncoding["kind"] => {
  if (contentType === "application/x-www-form-urlencoded") {
    return "form";
  }

  return contentType.startsWith("text/") || contentType.includes("xml")
    ? "text"
    : "json";
};

const findJsonContentType = (available: string[]): string | undefined =>
  available.find((type) => type === "application/json") ??
  available.find((type) => /^application\/([\w.+-]+\+)?json\b/.test(type));

/**
 * Whether a schema describes a JSON object, following `$ref`s and accepting a
 * composition whose branches all do.
 */
const resolvesToObject = (
  schema: OpenApiSchema | undefined,
  definitions: Record<string, OpenApiSchema>,
  depth = 0,
): boolean => {
  if (!schema || depth > 8) {
    return false;
  }

  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
    return resolvesToObject(
      definitions[schema.$ref.slice("#/$defs/".length)],
      definitions,
      depth + 1,
    );
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];

    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every((branch) =>
        resolvesToObject(branch as OpenApiSchema, definitions, depth + 1),
      );
    }
  }

  return schema.type === "object" || schema.properties !== undefined;
};

const selectContentType = (available: string[]): string | undefined =>
  findJsonContentType(available) ??
  available.find((type) => type === "application/x-www-form-urlencoded") ??
  available.find((type) => type.startsWith("text/") || type.includes("xml"));
