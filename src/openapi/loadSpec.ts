import type { OpenApiDocument } from "./types.js";

import { cancelResponseBody } from "../cancelResponseBody.js";

export type LoadedSpec = {
  document: OpenApiDocument;
  /**
   * The URL the document was loaded from, when it was loaded from one. Used to
   * resolve a relative `servers[0].url` against the document's own origin.
   */
  origin?: string;
};

/**
 * Loads an OpenAPI 3.x document, bundling external `$ref`s only when the
 * document actually has any.
 *
 * The bundler (`@apidevtools/swagger-parser`) is an optional peer dependency
 * imported on demand, not a hard one: it reaches for the filesystem and brings
 * its own JSON Schema stack with it. A single-file JSON document — which is
 * what most published specs are — needs neither, so the common path installs
 * and loads nothing extra. Multi-file documents and YAML are where the bundler
 * earns its weight, and only those pay for it.
 */
export const loadSpec = async (
  spec: Record<string, unknown> | string,
): Promise<LoadedSpec> => {
  if (typeof spec !== "string") {
    return {
      document: hasExternalRef(spec)
        ? await bundle(spec)
        : assertOpenApi3(spec as OpenApiDocument),
    };
  }

  const origin = isHttpUrl(spec) ? spec : undefined;
  const parsed = parseJson(await readSpecText(spec));

  // Re-bundling from the original string rather than from `parsed` is
  // deliberate: external refs resolve against whichever document they were
  // found in, so handing the bundler an already-parsed object would resolve
  // every one of them against the process's working directory instead of the
  // document's own location.
  if (!parsed || hasExternalRef(parsed)) {
    return { document: await bundle(spec), origin };
  }

  return { document: assertOpenApi3(parsed), origin };
};

const assertOpenApi3 = (document: OpenApiDocument): OpenApiDocument => {
  if (!document?.openapi?.startsWith("3.")) {
    const found =
      document?.openapi ??
      (document?.swagger ? `Swagger ${document.swagger}` : undefined);

    throw new Error(
      `fromOpenAPI supports OpenAPI 3.x documents only (found ${
        found ?? "no recognisable version field"
      }). Convert a Swagger 2.0 document first — https://converter.swagger.io converts one in place.`,
    );
  }

  return document;
};

const bundle = async (
  spec: Record<string, unknown> | string,
): Promise<OpenApiDocument> => {
  let parser;

  try {
    parser = await import("@apidevtools/swagger-parser");
  } catch {
    throw new Error(
      'This document is YAML or has external $refs, which needs the "@apidevtools/swagger-parser" package. ' +
        "Install it with: npm install @apidevtools/swagger-parser",
    );
  }

  // The package ships CommonJS, so depending on the loader the class arrives
  // as the module namespace, as `.default`, or as `.default.default` — the
  // same unwrapping `jsonSchemaAdapter` does for AJV.
  const SwaggerParser = unwrapDefault(unwrapDefault(parser)) as {
    bundle: (spec: unknown) => Promise<unknown>;
  };

  return assertOpenApi3((await SwaggerParser.bundle(spec)) as OpenApiDocument);
};

/**
 * Reports whether any `$ref` in the document points outside it. Iterative
 * rather than recursive: a large document (Stripe's is ~200k lines) nests
 * deeply enough to matter, and this runs before anything else has looked at
 * it.
 */
const hasExternalRef = (root: unknown): boolean => {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!node || typeof node !== "object" || seen.has(node)) {
      continue;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      // Pushed one at a time rather than spread: a document can hold an array
      // of tens of thousands of enum values, and spreading one of those into a
      // call exceeds the argument limit.
      for (const entry of node) {
        stack.push(entry);
      }

      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        if (!value.startsWith("#")) {
          return true;
        }

        continue;
      }

      stack.push(value);
    }
  }

  return false;
};

// Case-insensitive, as a scheme is: compared as written, `HTTPS://` was read as
// a file path and failed to load with ENOENT.
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // Not JSON — YAML, most likely, which the bundler parses.
    return undefined;
  }
};

const readSpecText = async (spec: string): Promise<string> => {
  if (isHttpUrl(spec)) {
    const response = await fetch(spec, {
      headers: { accept: "application/json, text/yaml, */*" },
    });

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(
        `Failed to fetch the OpenAPI document from ${spec}: ${response.status} ${response.statusText}`,
      );
    }

    return await response.text();
  }

  // Inline document text, rather than a path to one. Unambiguous for JSON;
  // YAML text is indistinguishable from a filename, so it is not accepted.
  if (spec.trimStart().startsWith("{")) {
    return spec;
  }

  // Imported on demand so that bundling this module for a runtime without a
  // filesystem does not fail on an unused import.
  const { readFile } = await import("node:fs/promises");

  return await readFile(spec, "utf8");
};

const unwrapDefault = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "default" in value
    ? (value as { default: unknown }).default
    : value;
