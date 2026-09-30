import { describe, expect, it } from "vitest";

import type { HttpRoute, OpenApiDocument } from "./types.js";

import { extractRoutes } from "./routes.js";

const get = (operationId?: string) => ({
  get: {
    ...(operationId ? { operationId } : {}),
    responses: { "200": { description: "OK" } },
  },
});

const pathParameter = (name: string) => ({
  in: "path" as const,
  name,
  required: true,
  schema: { type: "integer" },
});

const document = (overrides: Record<string, unknown>): OpenApiDocument =>
  ({
    info: { title: "Pets", version: "1.0.0" },
    openapi: "3.1.0",
    ...overrides,
  }) as OpenApiDocument;

/** Each route as `method path (parameter names)`. */
const labels = (routes: HttpRoute[]): string[] =>
  routes.map(
    (route) =>
      `${route.method} ${route.path} (${route.parameters
        .map((parameter) => parameter.name)
        .join(", ")})`,
  );

/**
 * A path item may be a `$ref` to another one: `components.pathItems` in
 * OpenAPI 3.1, an `x-` extension in 3.0, or — the common case — whatever the
 * bundler leaves behind when two paths share one external file, where the
 * second becomes a pointer at the first. A referenced item used to contribute
 * nothing: its operations were read off the `$ref` object itself, which has
 * none, so the path produced no tools and said nothing about it.
 */
describe("extractRoutes, path items declared by $ref", () => {
  it("reads the operations of a referenced path item", () => {
    const routes = extractRoutes(
      document({
        components: { pathItems: { Pets: get("listPets") } },
        paths: { "/pets": { $ref: "#/components/pathItems/Pets" } },
      }),
    );

    expect(labels(routes)).toEqual(["get /pets ()"]);
    expect(routes[0].operationId).toBe("listPets");
  });

  it("resolves a pointer at another path, as the bundler writes one", () => {
    const routes = extractRoutes(
      document({
        paths: {
          "/archived-pets/{petId}": { $ref: "#/paths/~1pets~1%7BpetId%7D" },
          "/pets/{petId}": {
            ...get(),
            parameters: [pathParameter("petId")],
          },
        },
      }),
    );

    expect(labels(routes)).toEqual([
      "get /archived-pets/{petId} (petId)",
      "get /pets/{petId} (petId)",
    ]);
  });

  it("keeps the fields written beside the reference", () => {
    const routes = extractRoutes(
      document({
        openapi: "3.0.3",
        paths: {
          "/pets/{petId}": {
            $ref: "#/x-path-items/Pet",
            parameters: [pathParameter("petId")],
          },
        },
        "x-path-items": { Pet: get("getPet") },
      }),
    );

    expect(labels(routes)).toEqual(["get /pets/{petId} (petId)"]);
  });

  it("follows a chain, keeping what an intermediate item adds", () => {
    const routes = extractRoutes(
      document({
        components: {
          pathItems: {
            Pet: get("getPet"),
            PetById: {
              $ref: "#/components/pathItems/Pet",
              parameters: [pathParameter("petId")],
            },
          },
        },
        paths: { "/pets/{petId}": { $ref: "#/components/pathItems/PetById" } },
      }),
    );

    expect(labels(routes)).toEqual(["get /pets/{petId} (petId)"]);
  });

  // The bundler inlines a shared item at its first referrer, siblings and all,
  // and points every later referrer there. Merging the two parameter lists
  // would hand the second path the first one's `petId`.
  it("lets a referrer's own parameters replace the referenced item's", () => {
    const routes = extractRoutes(
      document({
        paths: {
          "/archived-pets/{archivedId}": {
            $ref: "#/paths/~1pets~1%7BpetId%7D",
            parameters: [pathParameter("archivedId")],
          },
          "/pets/{petId}": {
            ...get(),
            parameters: [pathParameter("petId")],
          },
        },
      }),
    );

    expect(labels(routes)).toEqual([
      "get /archived-pets/{archivedId} (archivedId)",
      "get /pets/{petId} (petId)",
    ]);
  });

  it("stops at a reference cycle instead of following it forever", () => {
    const routes = extractRoutes(
      document({
        components: {
          pathItems: {
            A: { $ref: "#/components/pathItems/B" },
            B: { $ref: "#/components/pathItems/A" },
          },
        },
        paths: {
          "/loop": { $ref: "#/components/pathItems/A" },
          "/pets": get("listPets"),
        },
      }),
    );

    expect(labels(routes)).toEqual(["get /pets ()"]);
  });

  it("passes over a reference that points at nothing", () => {
    const routes = extractRoutes(
      document({
        paths: {
          "/missing": { $ref: "#/components/pathItems/Nowhere" },
          "/pets": get("listPets"),
        },
      }),
    );

    expect(labels(routes)).toEqual(["get /pets ()"]);
  });
});
