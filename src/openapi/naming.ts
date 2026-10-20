import type { HttpRoute, OperationSummary } from "./types.js";

import { toOperationSummary } from "./routes.js";

/**
 * Cap on a generated tool name. Nothing in MCP imposes one, but clients that
 * bridge to other tool-calling APIs do — 64 characters is the common limit —
 * and a name silently truncated by a client is worse than one shortened here.
 */
const MAX_NAME_LENGTH = 64;

/** Leaves room for a `_<n>` collision suffix without exceeding the cap. */
const MAX_BASE_LENGTH = MAX_NAME_LENGTH - 5;

/**
 * Assigns each route a unique tool name.
 *
 * Uniqueness is checked against the final name rather than the base, because a
 * document whose own `operationId`s already look suffixed — both `listPets`
 * and `listPets_2` — would otherwise produce two tools with the same name, and
 * only one of them would be reachable.
 */
export const generateToolNames = (
  routes: HttpRoute[],
  override: FromOpenAPIToolNames,
): Map<HttpRoute, string> => {
  const names = new Map<HttpRoute, string>();
  const taken = new Set<string>();

  for (const route of routes) {
    const base = slugify(baseNameFor(route, override));
    let name = base;

    for (let suffix = 2; taken.has(name); suffix++) {
      name = `${base}_${suffix}`;
    }

    taken.add(name);
    names.set(route, name);
  }

  return names;
};

type FromOpenAPIToolNames =
  | ((operation: OperationSummary) => string | undefined)
  | Record<string, string>
  | undefined;

const baseNameFor = (
  route: HttpRoute,
  override: FromOpenAPIToolNames,
): string => {
  // A record is read by its own keys only. Read through the prototype, an
  // `operationId` of `toString` or `constructor` found `Object.prototype`'s
  // function rather than no override, and building the server failed with
  // "value.replace is not a function".
  const explicit =
    typeof override === "function"
      ? override(toOperationSummary(route))
      : route.operationId &&
          override &&
          Object.hasOwn(override, route.operationId)
        ? override[route.operationId]
        : undefined;

  if (explicit) {
    return explicit;
  }

  if (route.operationId) {
    // Code generators — FastAPI's, notably — append the path and method to
    // the handler's own name behind a double underscore, producing
    // `read_item_items__item_id__get`. The prefix is the part a human wrote.
    return route.operationId.split("__")[0];
  }

  return route.summary || `${route.method}_${route.path}`;
};

const slugify = (value: string): string => {
  const slug = value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    // Trimming again: the slice can land mid-word and leave a trailing
    // separator that the first trim had nothing to remove.
    .replace(/[_-]+$/, "");

  return slug || "operation";
};
