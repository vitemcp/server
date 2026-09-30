import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { ViteMCP } from "../ViteMCP.js";
import type { OpenApiDocument } from "./types.js";

import { resolveBaseUrl } from "./executeRequest.js";
import { fromOpenAPI } from "./fromOpenAPI.js";

type Call = { body?: string; headers: Headers; method: string; url: URL };

type FromOpenAPIOptions = Parameters<typeof fromOpenAPI>[0];

/**
 * Builds a server from `document` whose generated tools record what they would
 * have sent instead of sending it, and connects a real MCP client to it — so
 * these assertions run through argument validation and the wire format rather
 * than around them.
 */
const withRecordedCalls = async (
  document: OpenApiDocument,
  options: Omit<FromOpenAPIOptions, "spec"> = {},
  respond: () => Response = () =>
    new Response("{}", { headers: { "content-type": "application/json" } }),
) => {
  const calls: Call[] = [];

  const server = (await fromOpenAPI({
    ...options,
    fetch: async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: new URL(String(input)),
      });

      init?.signal?.throwIfAborted();

      return respond();
    },
    spec: document as Record<string, unknown>,
  })) as ViteMCP;

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { calls, client };
};

const petstore: OpenApiDocument = {
  info: { title: "Pets", version: "1.0.0" },
  openapi: "3.0.3",
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { in: "path", name: "petId", schema: { type: "integer" } },
          {
            explode: false,
            in: "query",
            name: "fields",
            schema: { items: { type: "string" }, type: "array" },
          },
          { in: "header", name: "X-Trace", schema: { type: "string" } },
          { in: "cookie", name: "session", schema: { type: "string" } },
        ],
      },
    },
  },
  servers: [{ url: "https://api.example.test/v1" }],
};

/** Shaped after the form-encoded APIs that accept nested bodies. */
const formBodySpec: OpenApiDocument = {
  info: { title: "Payments", version: "1.0.0" },
  openapi: "3.0.3",
  paths: {
    "/charges": {
      post: {
        operationId: "createCharge",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                properties: {
                  amount: { type: "integer" },
                  expand: { items: { type: "string" }, type: "array" },
                  items: {
                    items: {
                      properties: { price: { type: "string" } },
                      type: "object",
                    },
                    type: "array",
                  },
                  metadata: { type: "object" },
                },
                type: "object",
              },
            },
          },
        },
      },
    },
  },
  servers: [{ url: "https://api.example.test" }],
};

describe("building the request", () => {
  it("routes each argument to the location its parameter names", async () => {
    const { calls, client } = await withRecordedCalls(petstore);

    await client.callTool({
      arguments: {
        fields: ["name", "tag"],
        petId: 7,
        session: "s1",
        "X-Trace": "abc",
      },
      name: "getPet",
    });

    expect(calls[0].url.toString()).toBe(
      "https://api.example.test/v1/pets/7?fields=name%2Ctag",
    );
    expect(calls[0].headers.get("x-trace")).toBe("abc");
    expect(calls[0].headers.get("cookie")).toBe("session=s1");
    expect(calls[0].method).toBe("GET");
  });

  it("keeps the server's own path prefix", async () => {
    const { calls, client } = await withRecordedCalls(petstore);

    await client.callTool({ arguments: { petId: 1 }, name: "getPet" });

    expect(calls[0].url.pathname).toBe("/v1/pets/1");
  });

  it("lets configured headers win over a same-named header parameter", async () => {
    // A model that can be talked into supplying its own `X-Trace` must not be
    // able to displace a credential the server was configured with.
    const { calls, client } = await withRecordedCalls(petstore, {
      headers: { "X-Trace": "server-owned" },
    });

    await client.callTool({
      arguments: { petId: 1, "X-Trace": "model-supplied" },
      name: "getPet",
    });

    expect(calls[0].headers.get("x-trace")).toBe("server-owned");
  });

  it("resolves headers per request, from the caller's own auth", async () => {
    const { calls, client } = await withRecordedCalls(petstore, {
      headers: (context) => ({
        authorization: `Bearer ${String(context.auth?.token ?? "anonymous")}`,
      }),
    });

    await client.callTool({ arguments: { petId: 1 }, name: "getPet" });

    expect(calls[0].headers.get("authorization")).toBe("Bearer anonymous");
  });

  it("appends configured query parameters, replacing a colliding one", async () => {
    const { calls, client } = await withRecordedCalls(petstore, {
      query: { fields: "server-owned" },
    });

    await client.callTool({
      arguments: { fields: ["name"], petId: 1 },
      name: "getPet",
    });

    expect(calls[0].url.searchParams.getAll("fields")).toEqual([
      "server-owned",
    ]);
  });

  it("cannot be walked out of the path by an argument", async () => {
    const { calls, client } = await withRecordedCalls({
      ...petstore,
      paths: {
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            parameters: [
              { in: "path", name: "petId", schema: { type: "string" } },
            ],
          },
        },
      },
    });

    await client.callTool({
      arguments: { petId: "../../admin" },
      name: "getPet",
    });

    expect(calls[0].url.pathname).toBe("/v1/pets/..%2F..%2Fadmin");
  });

  it("cannot be made to set a second cookie by an argument", async () => {
    const { calls, client } = await withRecordedCalls(petstore);

    await client.callTool({
      arguments: { petId: 1, session: "abc; admin=true" },
      name: "getPet",
    });

    // One cookie with an odd value, not two cookies. `=` stays as it is, since
    // base64 cookie values end in it.
    expect(calls[0].headers.get("cookie")).toBe("session=abc%3B%20admin=true");
  });

  it("sends a JSON body assembled from the flattened arguments", async () => {
    const { calls, client } = await withRecordedCalls({
      info: { title: "Pets", version: "1.0.0" },
      openapi: "3.0.3",
      paths: {
        "/pets": {
          post: {
            operationId: "addPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      name: { type: "string" },
                      tag: { type: "string" },
                    },
                    required: ["name"],
                    type: "object",
                  },
                },
              },
            },
          },
        },
      },
      servers: [{ url: "https://api.example.test" }],
    });

    await client.callTool({
      arguments: { name: "Rex", tag: "dog" },
      name: "addPet",
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      name: "Rex",
      tag: "dog",
    });
  });

  // An empty `properties` beside `additionalProperties` is how generators
  // write a dictionary. Flattened, it left the tool no argument to carry the
  // body in — only the query parameter that happens to share its name.
  it("sends a dictionary body whose schema declares an empty properties map", async () => {
    const { calls, client } = await withRecordedCalls({
      info: { title: "Labels", version: "1.0.0" },
      openapi: "3.0.3",
      paths: {
        "/labels": {
          post: {
            operationId: "setLabels",
            parameters: [
              { in: "query", name: "body", schema: { type: "string" } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    additionalProperties: { type: "string" },
                    properties: {},
                    type: "object",
                  },
                },
              },
              required: true,
            },
          },
        },
      },
      servers: [{ url: "https://api.example.test" }],
    });

    const sent = await client.callTool({
      arguments: {
        body: { environment: "staging", team: "infra" },
        body__query: "preview",
      },
      name: "setLabels",
    });

    expect(sent.isError).toBeFalsy();
    expect(calls[0].url.search).toBe("?body=preview");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body ?? "")).toEqual({
      environment: "staging",
      team: "infra",
    });

    // Still validated as the dictionary it is, before any request is made.
    const wrongValue = await client.callTool({
      arguments: { body: { team: 42 } },
      name: "setLabels",
    });

    expect(wrongValue.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("form-encodes a body the document declares as form-encoded", async () => {
    const { calls, client } = await withRecordedCalls({
      info: { title: "Auth", version: "1.0.0" },
      openapi: "3.0.3",
      paths: {
        "/token": {
          post: {
            operationId: "token",
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
      servers: [{ url: "https://api.example.test" }],
    });

    await client.callTool({
      arguments: { grant_type: "client_credentials" },
      name: "token",
    });

    expect(calls[0].headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(calls[0].body).toBe("grant_type=client_credentials");
  });

  it("repeats an array-valued form property once per entry", async () => {
    const { calls, client } = await withRecordedCalls(formBodySpec);

    await client.callTool({
      arguments: {
        amount: 500,
        expand: ["customer", "invoice"],
        metadata: { order: "42" },
      },
      name: "createCharge",
    });

    const body = new URLSearchParams(calls[0].body);

    // The OpenAPI default for a form body is `style: form, explode: true`:
    // one `expand=` per entry, not one JSON-encoded array.
    expect(body.getAll("expand")).toEqual(["customer", "invoice"]);
    expect(body.get("amount")).toBe("500");
    // A nested object is bracketed, which is the encoding an API accepting
    // nested form bodies reads. One JSON value would arrive as a single string.
    expect(body.get("metadata[order]")).toBe("42");
  });

  it("brackets a nested form object rather than JSON-encoding it", async () => {
    const { calls, client } = await withRecordedCalls(formBodySpec);

    await client.callTool({
      arguments: { metadata: { nested: { deep: "yes" }, order: "42" } },
      name: "createCharge",
    });

    const body = new URLSearchParams(calls[0].body);

    expect(body.get("metadata[order]")).toBe("42");
    expect(body.get("metadata[nested][deep]")).toBe("yes");
    expect(calls[0].body).not.toContain("%7B");
  });

  it("indexes an array of objects so the entries stay apart", async () => {
    const { calls, client } = await withRecordedCalls(formBodySpec);

    await client.callTool({
      arguments: { items: [{ price: "p1" }, { price: "p2" }] },
      name: "createCharge",
    });

    const body = new URLSearchParams(calls[0].body);

    // Repeating the key here would leave the server unable to tell which
    // `price` belonged to which entry.
    expect(body.get("items[0][price]")).toBe("p1");
    expect(body.get("items[1][price]")).toBe("p2");
  });
});

describe("reading the response", () => {
  it("returns a JSON object as structured content", async () => {
    const { client } = await withRecordedCalls(
      petstore,
      {},
      () =>
        new Response(JSON.stringify({ id: 7, name: "Rex" }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPet",
    });

    expect(result.structuredContent).toEqual({ id: 7, name: "Rex" });
    // Mirrored as text as well, for clients that do not read the structured form.
    expect(result.content).toEqual([
      { text: JSON.stringify({ id: 7, name: "Rex" }), type: "text" },
    ]);
  });

  it("pretty-prints a JSON array, which structured content cannot carry", async () => {
    const { client } = await withRecordedCalls(
      petstore,
      {},
      () =>
        new Response(JSON.stringify([1, 2]), {
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPet",
    });

    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ text: "[\n  1,\n  2\n]", type: "text" }]);
  });

  it("returns an image response as an image block", async () => {
    const { client } = await withRecordedCalls(
      petstore,
      {},
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPet",
    });

    expect(result.content).toEqual([
      { data: "AQID", mimeType: "image/png", type: "image" },
    ]);
  });

  it("turns a failure into a tool error carrying the response body", async () => {
    const { client } = await withRecordedCalls(
      petstore,
      {},
      () =>
        new Response("no such pet", { status: 404, statusText: "Not Found" }),
    );

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPet",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        text: "GET /pets/{petId} failed with 404 Not Found: no such pet",
        type: "text",
      },
    ]);
  });

  it("truncates a response too large to hand to a model", async () => {
    const { client } = await withRecordedCalls(
      petstore,
      { maxResponseCharacters: 20 },
      () =>
        new Response("x".repeat(100), {
          headers: { "content-type": "text/plain" },
        }),
    );

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPet",
    });

    expect(result.content).toEqual([
      {
        text: `${"x".repeat(20)}\n\n[truncated after 20 characters]`,
        type: "text",
      },
    ]);
  });

  it("rejects an argument the schema does not allow", async () => {
    const { client } = await withRecordedCalls(petstore);

    const result = await client.callTool({
      arguments: { petId: "seven" },
      name: "getPet",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /Input validation error.*petId: must be integer/,
    );
  });
});

describe("cancellation", () => {
  it("aborts the upstream request when the tool call is abandoned", async () => {
    let aborted = false;

    const server = (await fromOpenAPI({
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      spec: petstore as Record<string, unknown>,
      timeoutMs: 50,
    })) as ViteMCP;

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      arguments: { petId: 1 },
      name: "getPet",
    });

    expect(result.isError).toBe(true);
    expect(aborted).toBe(true);
  });
});

describe("resolveBaseUrl", () => {
  it("prefers an explicit override", () => {
    expect(
      resolveBaseUrl(
        [{ url: "https://spec.example" }],
        undefined,
        "https://override.example/",
      ),
    ).toBe("https://override.example");
  });

  it("substitutes server variables", () => {
    expect(
      resolveBaseUrl(
        [
          {
            url: "https://{region}.example.test/{version}",
            variables: {
              region: { default: "eu" },
              version: { default: "v2" },
            },
          },
        ],
        undefined,
        undefined,
      ),
    ).toBe("https://eu.example.test/v2");
  });

  it("resolves a relative server URL against where the document came from", () => {
    // Swagger's own Petstore ships `servers: [{ url: "/api/v3" }]`, which a
    // validator accepts and an HTTP client cannot use.
    expect(
      resolveBaseUrl(
        [{ url: "/api/v3" }],
        "https://petstore3.swagger.io/api/v3/openapi.json",
        undefined,
      ),
    ).toBe("https://petstore3.swagger.io/api/v3");
  });

  it("explains itself when a relative URL has no origin to resolve against", () => {
    expect(() =>
      resolveBaseUrl([{ url: "/api/v3" }], undefined, undefined),
    ).toThrow(
      /is relative, and the document was not loaded from an http\(s\) URL/,
    );
  });

  it("explains itself when the document names no server at all", () => {
    expect(() => resolveBaseUrl(undefined, undefined, undefined)).toThrow(
      /declares no `servers`/,
    );
  });
});
