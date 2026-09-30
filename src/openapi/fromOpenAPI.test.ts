import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ViteMCP } from "../ViteMCP.js";

import { fromOpenAPI } from "./fromOpenAPI.js";

/**
 * The document the test API serves about itself. Its `servers` entry is
 * relative — the shape Swagger's own Petstore publishes — so nothing here
 * works unless it is resolved against the origin the document was fetched
 * from.
 */
const DOCUMENT = {
  components: {
    schemas: {
      Pet: {
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          tag: { $ref: "#/components/schemas/Tag" },
        },
        required: ["name"],
        type: "object",
      },
      Tag: { nullable: true, type: "string" },
    },
  },
  info: { description: "A tiny pet API.", title: "Pets", version: "1.0.0" },
  openapi: "3.0.3",
  paths: {
    "/pets": {
      post: {
        operationId: "addPet",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
            description: "The pet that was stored.",
          },
        },
        summary: "Add a pet",
        tags: ["pet"],
      },
    },
    "/pets/{petId}": {
      delete: {
        deprecated: true,
        operationId: "removePet",
        parameters: [
          { in: "path", name: "petId", schema: { type: "integer" } },
        ],
        responses: { "204": { description: "Gone." } },
        tags: ["pet"],
      },
      get: {
        description: "Returns a single pet, or 404 when there is none.",
        operationId: "getPetById",
        parameters: [
          { in: "path", name: "petId", schema: { type: "integer" } },
          {
            description: "Include the tag in the response.",
            in: "query",
            name: "withTag",
            schema: { type: "boolean" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
            description: "The pet.",
          },
        },
        summary: "Find pet by ID",
        tags: ["pet"],
      },
    },
    "/status": {
      get: {
        operationId: "status",
        responses: { "200": { description: "OK" } },
        tags: ["ops"],
      },
    },
  },
  servers: [{ url: "/api/v3" }],
};

const PETS = new Map<number, { id: number; name: string; tag?: string }>([
  [7, { id: 7, name: "Rex", tag: "dog" }],
]);

let specUrl: string;
let server: http.Server;

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/openapi.json") {
      return json(response, 200, DOCUMENT);
    }

    const pet = /^\/api\/v3\/pets\/(\d+)$/.exec(url.pathname);

    if (pet && request.method === "GET") {
      const found = PETS.get(Number(pet[1]));

      if (!found) {
        return json(response, 404, { message: "No such pet." });
      }

      return json(
        response,
        200,
        url.searchParams.get("withTag") === "true"
          ? found
          : { id: found.id, name: found.name },
      );
    }

    if (url.pathname === "/api/v3/pets" && request.method === "POST") {
      const chunks: Buffer[] = [];

      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          name: string;
        };
        const created = { id: PETS.size + 1, ...body };

        PETS.set(created.id, created);
        json(response, 200, created);
      });

      return;
    }

    return json(response, 404, { message: "Not found." });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test API did not bind a port.");
  }

  specUrl = `http://127.0.0.1:${address.port}/openapi.json`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve(null)));
});

const connect = async (mcp: ViteMCP) => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return client;
};

describe("fromOpenAPI, end to end against a real API", () => {
  it("lists a tool per operation, read-first and without the deprecated one", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));
    const { tools } = await client.listTools();

    // Reads first, then by path — so the order is stable as the document grows.
    expect(tools.map((tool) => tool.name)).toEqual([
      "getPetById",
      "status",
      "addPet",
    ]);

    await client.close();
  });

  it("describes each tool with what the document says and how to reach it", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));
    const { tools } = await client.listTools();
    const getPet = tools.find((tool) => tool.name === "getPetById");

    expect(getPet?.description).toBe(
      "Find pet by ID\n\nReturns a single pet, or 404 when there is none.\n\nGET /pets/{petId}",
    );
    expect(getPet?.annotations).toEqual({
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
      title: "Find pet by ID",
    });

    const addPet = tools.find((tool) => tool.name === "addPet");

    expect(addPet?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
      readOnlyHint: false,
    });

    await client.close();
  });

  it("flattens parameters and body into one schema, with only the definitions it needs", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));
    const { tools } = await client.listTools();

    expect(
      tools.find((tool) => tool.name === "getPetById")?.inputSchema,
    ).toEqual({
      additionalProperties: false,
      properties: {
        petId: { type: "integer" },
        withTag: {
          description: "Include the tag in the response.",
          type: "boolean",
        },
      },
      required: ["petId"],
      type: "object",
    });

    // The body is a `$ref` to a component, which is how nearly every document
    // writes one — following it is what lets the body flatten into arguments
    // rather than sit behind one opaque `body` object.
    expect(tools.find((tool) => tool.name === "addPet")?.inputSchema).toEqual({
      $defs: {
        // `nullable: true` folded into the type, which AJV would otherwise
        // refuse to compile.
        Tag: { type: ["string", "null"] },
      },
      additionalProperties: false,
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        tag: { $ref: "#/$defs/Tag" },
      },
      required: ["name"],
      type: "object",
    });

    await client.close();
  });

  it("performs a real request and returns the response as structured content", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));

    const result = await client.callTool({
      arguments: { petId: 7, withTag: true },
      name: "getPetById",
    });

    expect(result.structuredContent).toEqual({
      id: 7,
      name: "Rex",
      tag: "dog",
    });

    await client.close();
  });

  it("sends a request body and reports a failure as a tool error", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));

    const created = await client.callTool({
      arguments: { name: "Fido" },
      name: "addPet",
    });

    expect(created.structuredContent).toMatchObject({ name: "Fido" });

    const missing = await client.callTool({
      arguments: { petId: 999 },
      name: "getPetById",
    });

    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/failed with 404/);

    await client.close();
  });

  it("narrows the tool list with include", async () => {
    const client = await connect(
      await fromOpenAPI({
        include: (operation) => operation.tags.includes("ops"),
        spec: specUrl,
      }),
    );

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "status",
    ]);

    await client.close();
  });

  it("declares an output schema when asked, and validates against it", async () => {
    const client = await connect(
      await fromOpenAPI({ outputSchema: true, spec: specUrl }),
    );

    const { tools } = await client.listTools();

    expect(
      tools.find((tool) => tool.name === "getPetById")?.outputSchema,
    ).toEqual({
      $defs: {
        Pet: {
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            tag: { $ref: "#/$defs/Tag" },
          },
          required: ["name"],
          type: "object",
        },
        Tag: { type: ["string", "null"] },
      },
      $ref: "#/$defs/Pet",
      type: "object",
    });

    const result = await client.callTool({
      arguments: { petId: 7 },
      name: "getPetById",
    });

    expect(result.structuredContent).toEqual({ id: 7, name: "Rex" });

    await client.close();
  });

  it("registers onto a server that already exists", async () => {
    const { ViteMCP: ViteMCPClass } = await import("../ViteMCP.js");
    const existing = new ViteMCPClass({ name: "Host", version: "1.0.0" });

    existing.addTool({
      execute: async () => "pong",
      name: "ping",
    });

    await fromOpenAPI({
      include: (operation) => operation.operationId === "status",
      server: existing,
      spec: specUrl,
    });

    const client = await connect(existing);

    expect(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual(["ping", "status"]);

    await client.close();
  });

  it("takes its name, description and version from the document", async () => {
    const client = await connect(await fromOpenAPI({ spec: specUrl }));

    expect(client.getServerVersion()).toMatchObject({
      name: "Pets",
      version: "1.0.0",
    });

    await client.close();
  });
});

describe("fromOpenAPI, a path item shared between paths", () => {
  const fixture = (name: string) =>
    fileURLToPath(
      new URL(`./fixtures/shared-path-items/${name}`, import.meta.url),
    );

  // The bundler inlines the shared file at the first path and leaves the
  // second as a pointer at it, which used to produce no tool at all.
  it("makes a tool for every path that references the same external file", async () => {
    const requested: string[] = [];
    const client = await connect(
      await fromOpenAPI({
        fetch: (async (input) => {
          requested.push(String(input));

          return new Response("{}", {
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
        spec: fixture("root.yaml"),
      }),
    );

    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();

    expect(names).toEqual(["get_archived-pets_petId", "get_pets_petId"]);

    for (const name of names) {
      const result = await client.callTool({ arguments: { petId: 42 }, name });

      expect(result.isError).toBeFalsy();
    }

    expect(requested.sort()).toEqual([
      "https://api.example.com/archived-pets/42",
      "https://api.example.com/pets/42",
    ]);

    await client.close();
  });

  it("gives each path only the parameters written beside its own reference", async () => {
    const client = await connect(
      await fromOpenAPI({ spec: fixture("sibling-parameters.yaml") }),
    );
    const { tools } = await client.listTools();

    expect(
      Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          Object.keys(tool.inputSchema.properties ?? {}),
        ]),
      ),
    ).toEqual({
      "get_archived-pets_archivedId": ["archivedId"],
      get_pets_petId: ["petId"],
    });

    await client.close();
  });
});
