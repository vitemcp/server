import { describe, expect, it } from "vitest";

import type { HttpMethod, HttpRoute } from "./types.js";

import { generateToolNames } from "./naming.js";

const route = (overrides: Partial<HttpRoute> = {}): HttpRoute => ({
  deprecated: false,
  method: "get" as HttpMethod,
  parameters: [],
  path: "/pets",
  responses: {},
  tags: [],
  ...overrides,
});

const namesOf = (
  routes: HttpRoute[],
  override?: Parameters<typeof generateToolNames>[1],
): string[] => [...generateToolNames(routes, override).values()];

describe("tool naming", () => {
  it("prefers the operationId", () => {
    expect(namesOf([route({ operationId: "listPets" })])).toEqual(["listPets"]);
  });

  it("keeps the hand-written prefix of a generated operationId", () => {
    expect(
      namesOf([route({ operationId: "read_item__items__item_id__get" })]),
    ).toEqual(["read_item"]);
  });

  it("falls back to the summary, then to the method and path", () => {
    expect(namesOf([route({ summary: "Find pet by ID" })])).toEqual([
      "Find_pet_by_ID",
    ]);

    expect(namesOf([route({ path: "/pets/{petId}" })])).toEqual([
      "get_pets_petId",
    ]);
  });

  it("suffixes a collision", () => {
    expect(
      namesOf([
        route({ operationId: "listPets" }),
        route({ operationId: "listPets" }),
        route({ operationId: "listPets" }),
      ]),
    ).toEqual(["listPets", "listPets_2", "listPets_3"]);
  });

  it("does not collide with a document whose own names look suffixed", () => {
    // Checking uniqueness against the base alone would hand both of these the
    // name `listPets_2`, and one tool would be unreachable.
    expect(
      namesOf([
        route({ operationId: "listPets" }),
        route({ operationId: "listPets_2" }),
        route({ operationId: "listPets" }),
      ]),
    ).toEqual(["listPets", "listPets_2", "listPets_3"]);
  });

  it("shortens a long name without leaving it ending in a separator", () => {
    const [name] = namesOf([route({ operationId: `${"a".repeat(58)} b` })]);

    expect(name).toHaveLength(58);
    expect(name.endsWith("_")).toBe(false);
  });

  it("takes an override by operationId", () => {
    expect(
      namesOf([route({ operationId: "listPets" })], { listPets: "pets_list" }),
    ).toEqual(["pets_list"]);
  });

  it("reads an override record by its own keys only", () => {
    // Read through the prototype, `toString` found `Object.prototype`'s
    // function rather than no override, and building the server failed.
    const routes = ["toString", "constructor", "valueOf"].map((operationId) =>
      route({ operationId }),
    );

    expect(namesOf(routes, {})).toEqual(["toString", "constructor", "valueOf"]);
    expect(namesOf(routes, { valueOf: "get_value" })).toEqual([
      "toString",
      "constructor",
      "get_value",
    ]);
  });

  it("takes an override function, falling back when it returns nothing", () => {
    expect(
      namesOf(
        [
          route({ method: "get", operationId: "listPets" }),
          route({ method: "post", operationId: "addPet" }),
        ],
        (operation) => (operation.method === "post" ? "create_pet" : undefined),
      ),
    ).toEqual(["listPets", "create_pet"]);
  });

  it("always produces a usable name", () => {
    expect(namesOf([route({ operationId: "***" })])).toEqual(["operation"]);
  });
});
