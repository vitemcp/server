import type { OpenApiDocument, OpenApiSchema } from "./types.js";

export type SchemaNormalizer = {
  /**
   * Every definition hoisted so far, keyed by its `$defs` name. Grows as
   * schemas are normalized; `collectDefinitions` picks the subset one tool
   * actually references.
   */
  definitions: Record<string, OpenApiSchema>;
  /** Rewrites one document schema fragment into standalone JSON Schema. */
  normalize: (schema: unknown) => OpenApiSchema;
};

/**
 * Keywords whose *keys* are arbitrary names rather than keywords, so the map
 * itself is not a schema and must not be run through the keyword rewrites — a
 * property genuinely named `nullable` or `required` would otherwise be
 * mangled into the keyword of the same name and lost.
 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/**
 * Keywords holding instance data rather than sub-schemas. Descending into
 * these would rewrite a `$ref`-shaped key inside somebody's example payload.
 */
const VALUE_KEYWORDS = new Set([
  "const",
  "default",
  "enum",
  "example",
  "examples",
]);

/**
 * Builds a normalizer that turns document schemas into JSON Schema the MCP
 * client — and AJV, via `jsonSchemaAdapter` — will accept.
 *
 * Two jobs. It hoists every local `$ref` into a flat `$defs` table under a
 * name safe to write in a pointer, so a tool's input schema stands alone once
 * detached from the document. And it reconciles the places where OpenAPI is
 * not quite JSON Schema (see `normalizeKeywords`), which real documents lean
 * on constantly.
 */
export const createSchemaNormalizer = (
  document: OpenApiDocument,
): SchemaNormalizer => {
  const definitions: Record<string, OpenApiSchema> = {};
  const namesByPointer = new Map<string, string>();
  const takenNames = new Set<string>();

  /**
   * Hoists whatever `pointer` addresses into `$defs`, returning its name.
   *
   * Names are slugified rather than reused verbatim: a `components.schemas`
   * key may contain a space, a slash or a tilde, each of which has to be
   * escaped to survive a round trip through a `$ref` pointer. Renaming once,
   * here, is simpler than encoding correctly at every use.
   */
  const hoist = (pointer: string): string | undefined => {
    const existing = namesByPointer.get(pointer);

    if (existing !== undefined) {
      return existing;
    }

    const target = readPointer(document, pointer);

    if (!target || typeof target !== "object") {
      return undefined;
    }

    const segments = pointer.split("/");
    const base =
      slugify(decodeSegment(segments[segments.length - 1] ?? "")) || "schema";
    let name = base;

    for (let suffix = 2; takenNames.has(name); suffix++) {
      name = `${base}_${suffix}`;
    }

    takenNames.add(name);
    // Registered before the target is normalized, so that a schema that
    // references itself finds the name already reserved instead of recursing
    // forever.
    namesByPointer.set(pointer, name);
    definitions[name] = {};
    definitions[name] = normalize(target);

    return name;
  };

  const normalize = (value: unknown): OpenApiSchema => {
    const rewritten = rewrite(value);

    return rewritten &&
      typeof rewritten === "object" &&
      !Array.isArray(rewritten)
      ? (rewritten as OpenApiSchema)
      : {};
  };

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => rewrite(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(source)) {
      if (key === "$ref" && typeof entry === "string") {
        const name = entry.startsWith("#")
          ? hoist(toPointer(entry))
          : undefined;

        // A dangling or external ref becomes an unconstrained schema rather
        // than a compile error: one bad pointer in a large document should
        // cost that one field its validation, not the whole server.
        if (name !== undefined) {
          result.$ref = `#/$defs/${name}`;
        }

        continue;
      }

      if (VALUE_KEYWORDS.has(key)) {
        result[key] = entry;
        continue;
      }

      if (SCHEMA_MAP_KEYWORDS.has(key) && entry && typeof entry === "object") {
        result[key] = Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(
            ([name, schema]) => [name, rewrite(schema)],
          ),
        );
        continue;
      }

      result[key] = rewrite(entry);
    }

    return normalizeKeywords(result);
  };

  return { definitions, normalize };
};

/**
 * Returns the transitive closure of the `$defs` a schema references, or
 * `undefined` when it references none.
 *
 * Only the ones actually reached: attaching every definition in the document
 * to every tool would multiply the `tools/list` payload by the tool count for
 * no benefit, and on a large document that alone can run to megabytes.
 */
export const collectDefinitions = (
  schema: unknown,
  definitions: Record<string, OpenApiSchema>,
): Record<string, OpenApiSchema> | undefined => {
  const referenced = new Set<string>();
  const stack: unknown[] = [schema];

  while (stack.length > 0) {
    const node = stack.pop();

    if (Array.isArray(node)) {
      // One at a time rather than spread: see `hasExternalRef` in loadSpec.ts.
      for (const entry of node) {
        stack.push(entry);
      }

      continue;
    }

    if (!node || typeof node !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = value.startsWith("#/$defs/")
          ? value.slice("#/$defs/".length)
          : undefined;

        if (
          name !== undefined &&
          name in definitions &&
          !referenced.has(name)
        ) {
          referenced.add(name);
          stack.push(definitions[name]);
        }

        continue;
      }

      stack.push(value);
    }
  }

  if (referenced.size === 0) {
    return undefined;
  }

  return Object.fromEntries(
    [...referenced].sort().map((name) => [name, definitions[name]]),
  );
};

/**
 * `schema` with each read-only property taken out of the `required` list beside
 * it, at any depth — for a tool's input, which is the request. OpenAPI 3.0 says
 * a read-only property "SHOULD NOT be sent as part of the request", and that a
 * `required` naming one "will take effect on the response only"; JSON Schema,
 * which 3.1 defers to, has the server ignore or refuse one that is sent.
 * Generators reuse one schema for both directions, so a server-assigned `id`
 * left required refused every call that did not invent one.
 *
 * The property itself stays, so a model may still send a value it has, such as
 * the unchanged one on a PUT. Builds new nodes rather than editing `schema`:
 * the same definitions describe the response, which does carry them.
 */
export const withoutReadOnlyRequired = (schema: unknown): unknown => {
  if (Array.isArray(schema)) {
    return schema.map((entry) => withoutReadOnlyRequired(entry));
  }

  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(schema)) {
    if (VALUE_KEYWORDS.has(key)) {
      result[key] = entry;
    } else if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      entry &&
      typeof entry === "object"
    ) {
      result[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(
          ([name, member]) => [name, withoutReadOnlyRequired(member)],
        ),
      );
    } else {
      result[key] = withoutReadOnlyRequired(entry);
    }
  }

  const { properties, required } = result;

  if (Array.isArray(required) && properties && typeof properties === "object") {
    const writable = required.filter(
      (name) =>
        typeof name !== "string" ||
        !Object.hasOwn(properties, name) ||
        (properties as Record<string, OpenApiSchema>)[name]?.readOnly !== true,
    );

    if (writable.length > 0) {
      result.required = writable;
    } else {
      delete result.required;
    }
  }

  return result;
};

/**
 * Reconciles the three places OpenAPI diverges from the JSON Schema dialect
 * AJV compiles, each of which is common enough in published documents to be
 * worth handling rather than reporting.
 *
 * `nullable: true` widens a sibling `type` in OpenAPI 3.0 but is not itself a
 * JSON Schema keyword, and AJV rejects one that has no `type` to widen — which
 * documents do emit, as a sibling of `oneOf` or `$ref`. Draft-04's boolean
 * `exclusiveMinimum`/`exclusiveMaximum` qualify a sibling bound rather than
 * being one. And a `required: true` left over from draft-04 belongs on the
 * parent as a list, not on the property as a flag; there is nothing to
 * translate it into here, so it is dropped.
 */
const normalizeKeywords = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    !("nullable" in schema) &&
    !("required" in schema) &&
    typeof schema.exclusiveMaximum !== "boolean" &&
    typeof schema.exclusiveMinimum !== "boolean"
  ) {
    return schema;
  }

  const result = { ...schema };

  if ("required" in result && !Array.isArray(result.required)) {
    delete result.required;
  }

  for (const [flag, bound] of [
    ["exclusiveMaximum", "maximum"],
    ["exclusiveMinimum", "minimum"],
  ] as const) {
    if (typeof result[flag] !== "boolean") {
      continue;
    }

    const inclusive = result[bound];

    if (result[flag] === true && typeof inclusive === "number") {
      result[flag] = inclusive;
      delete result[bound];
    } else {
      delete result[flag];
    }
  }

  if ("nullable" in result) {
    const nullable = result.nullable;
    const type = result.type;

    delete result.nullable;

    if (nullable === true && typeof type === "string") {
      result.type = [type, "null"];
    } else if (nullable === true && Array.isArray(type)) {
      result.type = type.includes("null") ? type : [...type, "null"];
    }
  }

  return result;
};

/**
 * Reads an RFC 6901 JSON Pointer, given as the path part of a fragment.
 *
 * Pointers are not followed through a `$ref` encountered mid-walk. They do not
 * need to be: a target that is itself a `$ref` normalizes into another `$ref`,
 * which hoists in turn, so chains resolve without a second traversal that a
 * cyclic document could trap.
 * Segments arrive percent-encoded (the bundler writes a path like
 * `/pets/{petId}` as `~1pets~1%7BpetId%7D`), so each needs decoding before its
 * `~1`/`~0` escapes are undone.
 */
const readPointer = (root: unknown, pointer: string): unknown => {
  if (pointer === "") {
    return root;
  }

  let node: unknown = root;

  for (const segment of pointer.split("/").slice(1)) {
    node = (node as Record<string, unknown> | undefined)?.[
      decodeSegment(segment)
    ];
  }

  return node;
};

/**
 * Undoes the two encodings a pointer segment carries: percent-encoding, from
 * being written as a URI fragment, and then RFC 6901's `~1`/`~0` escapes.
 */
const decodeSegment = (segment: string): string => {
  let decoded = segment;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not valid percent-encoding, so it was never encoded: use it verbatim.
  }

  return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
};

const slugify = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const toPointer = (ref: string): string => ref.slice(1);
