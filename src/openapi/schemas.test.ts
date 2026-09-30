import { describe, expect, it } from "vitest";

import type { HttpRoute, OpenApiDocument, OpenApiSchema } from "./types.js";

import { createSchemaNormalizer } from "./normalize.js";
import { extractRoutes } from "./routes.js";
import { buildToolBinding } from "./schemas.js";

const bind = (document: OpenApiDocument, withOutputSchema = false) => {
  const routes = extractRoutes(document);
  const normalizer = createSchemaNormalizer(document);

  return routes.map((route: HttpRoute) => ({
    binding: buildToolBinding(route, normalizer, withOutputSchema),
    route,
  }));
};

const jsonBody = (schema: Record<string, unknown>, required = true) => ({
  content: { "application/json": { schema } },
  required,
});

describe("flattening parameters into a tool schema", () => {
  it("puts every location into one flat argument list", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets/{petId}": {
          get: {
            parameters: [
              { in: "path", name: "petId", schema: { type: "integer" } },
              { in: "query", name: "verbose", schema: { type: "boolean" } },
              { in: "header", name: "X-Trace", schema: { type: "string" } },
            ],
          },
        },
      },
    });

    expect(binding.inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        petId: { type: "integer" },
        verbose: { type: "boolean" },
        "X-Trace": { type: "string" },
      },
      required: ["petId"],
      type: "object",
    });
  });

  it("makes a path parameter required even when the document forgets to", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets/{petId}": {
          get: {
            parameters: [
              {
                in: "path",
                name: "petId",
                required: false,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    });

    expect(binding.inputSchema.required).toEqual(["petId"]);
  });

  it("suffixes a name that collides across locations", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets/{id}": {
          get: {
            parameters: [
              { in: "path", name: "id", schema: { type: "integer" } },
              { in: "query", name: "id", schema: { type: "string" } },
            ],
          },
        },
      },
    });

    expect(Object.keys(binding.inputSchema.properties ?? {}).sort()).toEqual([
      "id__path",
      "id__query",
    ]);
    expect(binding.parameters.id__query).toEqual({
      kind: "parameter",
      parameter: { in: "query", name: "id", schema: { type: "string" } },
    });
  });

  it("lets a body property keep the bare name when a parameter collides with it", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: {
            parameters: [
              { in: "query", name: "name", schema: { type: "string" } },
            ],
            requestBody: jsonBody({
              properties: { name: { type: "string" } },
              required: ["name"],
              type: "object",
            }),
          },
        },
      },
    });

    expect(Object.keys(binding.inputSchema.properties ?? {}).sort()).toEqual([
      "name",
      "name__query",
    ]);
    expect(binding.parameters.name).toEqual({ kind: "body", name: "name" });
  });

  it("carries a parameter's own description and deprecation into the schema", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets": {
          get: {
            parameters: [
              {
                deprecated: true,
                description: "Maximum number to return.",
                in: "query",
                name: "limit",
                schema: { type: "integer" },
              },
            ],
          },
        },
      },
    });

    expect(binding.inputSchema.properties?.limit).toEqual({
      description: "Deprecated. Maximum number to return.",
      type: "integer",
    });
  });

  it("attaches only the definitions the operation reaches", () => {
    const [{ binding }] = bind({
      components: {
        schemas: {
          Pet: {
            properties: { tag: { $ref: "#/components/schemas/Tag" } },
            type: "object",
          },
          Tag: { type: "string" },
          Unrelated: { type: "object" },
        },
      },
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: { requestBody: jsonBody({ $ref: "#/components/schemas/Pet" }) },
        },
      },
    });

    // `Pet` itself is gone: its properties were flattened into arguments, so
    // only what those properties still point at has to travel with the tool.
    expect(Object.keys(binding.inputSchema.$defs as object)).toEqual(["Tag"]);
    expect(binding.inputSchema.properties).toEqual({
      tag: { $ref: "#/$defs/Tag" },
    });
  });
});

describe("request bodies", () => {
  it("flattens an object body into individual arguments", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: {
            requestBody: jsonBody({
              properties: { name: { type: "string" }, tag: { type: "string" } },
              required: ["name"],
              type: "object",
            }),
          },
        },
      },
    });

    expect(binding.wholeBodyKey).toBeUndefined();
    expect(binding.bodyEncoding).toEqual({
      contentType: "application/json",
      kind: "json",
    });
    expect(binding.inputSchema.required).toEqual(["name"]);
  });

  it("exposes a non-object body as a single argument", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: {
            requestBody: jsonBody({ items: { type: "string" }, type: "array" }),
          },
        },
      },
    });

    expect(binding.wholeBodyKey).toBe("body");
    expect(binding.inputSchema.properties?.body).toEqual({
      items: { type: "string" },
      type: "array",
    });
    expect(binding.inputSchema.required).toEqual(["body"]);
  });

  // The second shape is how a generator writes a record: zod-to-json-schema's
  // OpenAPI target puts an empty `properties` beside the value schema.
  it.each([
    { additionalProperties: { type: "string" }, type: "object" },
    {
      additionalProperties: { type: "string" },
      properties: {},
      type: "object",
    },
  ])("exposes a dictionary body as a single argument: %j", (schema) => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: { "/labels": { put: { requestBody: jsonBody(schema) } } },
    });

    expect(binding.wholeBodyKey).toBe("body");
    expect(binding.inputSchema.properties).toEqual({ body: schema });
    expect(binding.inputSchema.required).toEqual(["body"]);
  });

  it("keeps an object that declares no keys whole, so it can still be sent", () => {
    const schema = {
      additionalProperties: false,
      properties: {},
      type: "object",
    };
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: { "/touch": { post: { requestBody: jsonBody(schema) } } },
    });

    // Flattened into no arguments at all, a required `{}` could not be sent.
    expect(binding.wholeBodyKey).toBe("body");
    expect(binding.inputSchema.properties).toEqual({ body: schema });
  });

  it("ignores a body declared on a GET, which fetch cannot send", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/search": {
          get: {
            requestBody: jsonBody({
              properties: { q: { type: "string" } },
              type: "object",
            }),
          },
        },
      },
    });

    expect(binding.inputSchema.properties).toEqual({});
    expect(binding.bodyEncoding).toBeUndefined();
  });

  it("recognises a form-encoded body", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/token": {
          post: {
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    properties: { grant_type: { type: "string" } },
                    type: "object",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(binding.bodyEncoding).toEqual({
      contentType: "application/x-www-form-urlencoded",
      kind: "form",
    });
    expect(Object.keys(binding.inputSchema.properties ?? {})).toEqual([
      "grant_type",
    ]);
  });

  it("says so in the description when the body cannot be modelled", () => {
    const [{ binding }] = bind({
      openapi: "3.0.3",
      paths: {
        "/upload": {
          post: {
            requestBody: {
              content: {
                "multipart/form-data": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    });

    expect(binding.bodyEncoding).toBeUndefined();
    expect(binding.caveat).toMatch(
      /multipart\/form-data body, which this tool cannot construct/,
    );
  });
});

describe("output schemas", () => {
  const documentReturning = (
    schema: Record<string, unknown>,
  ): OpenApiDocument => ({
    openapi: "3.0.3",
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": { content: { "application/json": { schema } } },
          },
        },
      },
    },
  });

  it("is absent unless asked for", () => {
    const [{ binding }] = bind(documentReturning({ type: "object" }));

    expect(binding.outputSchema).toBeUndefined();
  });

  it("declares an object response", () => {
    const [{ binding }] = bind(
      documentReturning({
        properties: { id: { type: "integer" } },
        type: "object",
      }),
      true,
    );

    expect(binding.outputSchema).toEqual({
      properties: { id: { type: "integer" } },
      type: "object",
    });
  });

  it("declines an array response, which structured content cannot carry", () => {
    const [{ binding }] = bind(
      documentReturning({ items: { type: "string" }, type: "array" }),
      true,
    );

    expect(binding.outputSchema).toBeUndefined();
  });

  it("follows a $ref to decide whether the response is an object", () => {
    const [{ binding }] = bind(
      {
        components: {
          schemas: { Pet: { properties: { id: {} }, type: "object" } },
        },
        openapi: "3.0.3",
        paths: {
          "/pets": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      true,
    );

    expect(binding.outputSchema).toEqual({
      $defs: { Pet: { properties: { id: {} }, type: "object" } },
      $ref: "#/$defs/Pet",
      type: "object",
    });
  });

  /**
   * A document whose `Root` component reaches `total - 1` others, which is how
   * a large document's schemas relate: one root, the rest pulled in
   * transitively. `Root` counts toward the total, so the response schema
   * collects exactly `total` definitions.
   */
  const documentReferencing = (
    total: number,
    withRequestBody = false,
  ): OpenApiDocument => {
    const parts = total - 1;
    const schemas: Record<string, OpenApiSchema> = {
      Root: {
        properties: Object.fromEntries(
          Array.from({ length: parts }, (_, index) => [
            `field${index}`,
            { $ref: `#/components/schemas/Part${index}` },
          ]),
        ),
        type: "object",
      },
    };

    for (let index = 0; index < parts; index++) {
      schemas[`Part${index}`] = { properties: { id: {} }, type: "object" };
    }

    return {
      components: { schemas },
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: {
            ...(withRequestBody
              ? {
                  requestBody: jsonBody({
                    properties: {
                      payload: { $ref: "#/components/schemas/Root" },
                    },
                    type: "object",
                  }),
                }
              : {}),
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Root" },
                  },
                },
              },
            },
          },
        },
      },
    };
  };

  it("keeps a response schema that stays within the definition cap", () => {
    const [{ binding }] = bind(documentReferencing(100), true);

    expect(Object.keys(binding.outputSchema?.$defs ?? {})).toHaveLength(100);
  });

  it("drops a response schema that pulls in more definitions than the cap", () => {
    // Every tool's schema travels in one `tools/list`, so a runaway schema is
    // dropped rather than truncated: dangling `$ref`s would break the others.
    const [{ binding }] = bind(documentReferencing(101), true);

    expect(binding.outputSchema).toBeUndefined();
  });

  it("leaves the input schema alone however many definitions it pulls in", () => {
    const [{ binding }] = bind(documentReferencing(101, true), true);

    // The cap is a policy about what is safe to drop, and only a response
    // schema is: dropping an input schema would leave the tool uncallable.
    expect(Object.keys(binding.inputSchema.$defs ?? {})).toHaveLength(101);
    expect(binding.outputSchema).toBeUndefined();
  });
});

describe("route extraction", () => {
  it("resolves a shared parameter and lets the operation override it", () => {
    const [{ route }] = bind({
      components: {
        parameters: {
          Limit: { in: "query", name: "limit", schema: { type: "integer" } },
        },
      },
      openapi: "3.0.3",
      paths: {
        "/pets": {
          get: {
            parameters: [
              { in: "query", name: "limit", schema: { type: "string" } },
            ],
          },
          parameters: [{ $ref: "#/components/parameters/Limit" }],
        },
      },
    });

    expect(route.parameters).toEqual([
      { in: "query", name: "limit", schema: { type: "string" } },
    ]);
  });

  it("keeps a path-level parameter the operation does not shadow", () => {
    const [{ route }] = bind({
      openapi: "3.0.3",
      paths: {
        "/pets/{petId}": {
          get: { parameters: [{ in: "query", name: "verbose" }] },
          parameters: [{ in: "path", name: "petId" }],
        },
      },
    });

    expect(route.parameters.map((parameter) => parameter.name)).toEqual([
      "petId",
      "verbose",
    ]);
  });
});
