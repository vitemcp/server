import { describe, expect, it } from "vitest";

import type { OpenApiParameter } from "./types.js";

import {
  appendQueryParameter,
  serializePathParameter,
  serializeSimpleParameter,
  toQueryString,
} from "./parameters.js";

const parameter = (overrides: Partial<OpenApiParameter>): OpenApiParameter => ({
  in: "query",
  name: "tags",
  ...overrides,
});

const queryString = (
  overrides: Partial<OpenApiParameter>,
  value: unknown,
): string => {
  const query = new URLSearchParams();
  appendQueryParameter(query, parameter(overrides), value);
  return decodeURIComponent(toQueryString(query));
};

describe("query parameters", () => {
  it("repeats the key for an array under the default form/explode style", () => {
    expect(queryString({}, ["a", "b"])).toBe("tags=a&tags=b");
  });

  it("joins an array with a comma when explode is off", () => {
    expect(queryString({ explode: false }, ["a", "b"])).toBe("tags=a,b");
  });

  it("uses the delimiter the style names", () => {
    expect(queryString({ style: "spaceDelimited" }, ["a", "b"])).toBe(
      "tags=a b",
    );
    expect(queryString({ style: "pipeDelimited" }, ["a", "b"])).toBe(
      "tags=a|b",
    );
  });

  it("spreads an exploded object across its own keys", () => {
    expect(queryString({ name: "filter" }, { colour: "red", size: 2 })).toBe(
      "colour=red&size=2",
    );
  });

  it("flattens an unexploded object into alternating key and value", () => {
    expect(
      queryString({ explode: false, name: "filter" }, { colour: "red" }),
    ).toBe("filter=colour,red");
  });

  it("brackets each property under deepObject", () => {
    expect(
      queryString({ name: "filter", style: "deepObject" }, { colour: "red" }),
    ).toBe("filter[colour]=red");
  });

  it("skips a parameter with no value", () => {
    expect(queryString({}, undefined)).toBe("");
    expect(queryString({}, null)).toBe("");
  });

  it.each([
    { explode: true, style: "form" },
    { explode: false, style: "form" },
    { explode: false, style: "spaceDelimited" },
    { explode: false, style: "pipeDelimited" },
  ])(
    "skips an empty array or object with style=$style, explode=$explode",
    (overrides) => {
      // Not `tags=`, which an API would read as a filter for the empty string.
      expect(queryString(overrides, [])).toBe("");
      expect(queryString(overrides, {})).toBe("");
      expect(queryString(overrides, { colour: undefined })).toBe("");
    },
  );

  it("still sends an empty string, which is a value", () => {
    expect(queryString({ explode: false }, "")).toBe("tags=");
  });

  it("sends a nested object as JSON rather than [object Object]", () => {
    expect(queryString({ name: "where" }, [{ id: 1 }])).toBe('where={"id":1}');
  });

  it.each([
    { expected: "tags=a&tags=b", overrides: {} },
    { expected: "tags=a,b", overrides: { explode: false } },
    { expected: "tags=a|b", overrides: { style: "pipeDelimited" } },
    { expected: "tags=a b", overrides: { style: "spaceDelimited" } },
  ])(
    "leaves a null item out of an array with $overrides",
    ({ expected, overrides }) => {
      // Not `tags=a&tags=null&tags=b`, a filter on the word `null`.
      expect(queryString(overrides, ["a", null, "b"])).toBe(expected);
    },
  );

  it("leaves a null member out of an object, whatever the style", () => {
    const range = { gte: 1, lte: null };

    expect(queryString({}, range)).toBe("gte=1");
    expect(queryString({ explode: false }, range)).toBe("tags=gte,1");
    expect(queryString({ style: "deepObject" }, range)).toBe("tags[gte]=1");
  });

  it.each([{}, { explode: false }, { style: "deepObject" }])(
    "leaves out an array or object of nulls alone, as an empty one, with %o",
    (overrides) => {
      expect(queryString(overrides, [null])).toBe("");
      expect(queryString(overrides, { lte: null })).toBe("");
    },
  );

  it("keeps a null nested inside a member, which is sent as JSON", () => {
    expect(queryString({ name: "where" }, [{ id: null }])).toBe(
      'where={"id":null}',
    );
  });
});

describe("path parameters", () => {
  it("comma-joins an array and percent-encodes each value", () => {
    expect(
      serializePathParameter(parameter({ in: "path" }), ["a b", "c/d"]),
    ).toBe("a%20b,c%2Fd");
  });

  it("pairs an object's keys and values", () => {
    expect(
      serializePathParameter(parameter({ in: "path" }), { role: "admin" }),
    ).toBe("role,admin");
  });

  it("writes an exploded object as key=value", () => {
    expect(
      serializePathParameter(parameter({ explode: true, in: "path" }), {
        role: "admin",
      }),
    ).toBe("role=admin");
  });

  it("prefixes a label style with a dot", () => {
    expect(
      serializePathParameter(parameter({ in: "path", style: "label" }), [
        "a",
        "b",
      ]),
    ).toBe(".a,b");
  });

  it("names the parameter in a matrix style", () => {
    expect(
      serializePathParameter(parameter({ in: "path", style: "matrix" }), [
        "a",
        "b",
      ]),
    ).toBe(";tags=a,b");

    expect(
      serializePathParameter(
        parameter({ explode: true, in: "path", style: "matrix" }),
        ["a", "b"],
      ),
    ).toBe(";tags=a;tags=b");
  });

  it("percent-encodes the keys of an exploded matrix object", () => {
    // Left as written, a key holding `/` added a path segment.
    expect(
      serializePathParameter(
        parameter({ explode: true, in: "path", style: "matrix" }),
        { "a/b": "c d" },
      ),
    ).toBe(";a%2Fb=c%20d");
  });
});

describe("header and cookie parameters", () => {
  it("comma-joins an array without percent-encoding", () => {
    expect(
      serializeSimpleParameter(parameter({ in: "header" }), ["a b", "c"]),
    ).toBe("a b,c");
  });

  it("writes an exploded object as key=value pairs", () => {
    expect(
      serializeSimpleParameter(parameter({ explode: true, in: "header" }), {
        a: 1,
        b: 2,
      }),
    ).toBe("a=1,b=2");
  });

  it("leaves a null member out of an array or object", () => {
    expect(
      serializeSimpleParameter(parameter({ in: "header" }), ["a", null, "b"]),
    ).toBe("a,b");
    expect(
      serializeSimpleParameter(parameter({ in: "header" }), { a: 1, b: null }),
    ).toBe("a,1");
    expect(
      serializeSimpleParameter(parameter({ explode: true, in: "cookie" }), {
        a: 1,
        b: null,
      }),
    ).toBe("a=1");
  });
});
