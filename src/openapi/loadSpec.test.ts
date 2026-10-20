import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { loadSpec } from "./loadSpec.js";

const MULTI_FILE_SPEC = fileURLToPath(
  new URL("./fixtures/multi-file/root.yaml", import.meta.url),
);

const minimalDocument = {
  info: { title: "Pets", version: "1.0.0" },
  openapi: "3.0.3",
  paths: {},
};

const servers: http.Server[] = [];

const serve = async (body: string, contentType = "application/json") => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a port.");
  }

  return `http://127.0.0.1:${address.port}/openapi.json`;
};

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) => new Promise((resolve) => server.close(() => resolve(null))),
    ),
  );
});

describe("loadSpec", () => {
  it("takes an already-parsed document", async () => {
    const { document, origin } = await loadSpec(minimalDocument);

    expect(document.info?.title).toBe("Pets");
    expect(origin).toBeUndefined();
  });

  it("takes a document as inline JSON text", async () => {
    const { document } = await loadSpec(JSON.stringify(minimalDocument));

    expect(document.info?.title).toBe("Pets");
  });

  it("fetches a document over http and remembers where it came from", async () => {
    const url = await serve(JSON.stringify(minimalDocument));
    const { document, origin } = await loadSpec(url);

    expect(document.info?.title).toBe("Pets");
    // Kept so that a relative `servers` entry has something to resolve against.
    expect(origin).toBe(url);
  });

  it("fetches a document whose URL spells the scheme in capitals", async () => {
    // Compared as written, `HTTP://` was read as a file path: ENOENT.
    const url = (await serve(JSON.stringify(minimalDocument))).replace(
      /^http/,
      "HTTP",
    );
    const { document, origin } = await loadSpec(url);

    expect(document.info?.title).toBe("Pets");
    expect(origin).toBe(url);
  });

  it("releases the response body when the fetch fails", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => controller.enqueue(new TextEncoder().encode("no")),
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(body, { status: 404, statusText: "Not Found" }),
      );

    try {
      await expect(
        loadSpec("https://example.test/openapi.json"),
      ).rejects.toThrow(/Failed to fetch the OpenAPI document/);

      // Left unread, the body holds its socket until GC runs.
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects Swagger 2.0 with a pointer at what to do about it", async () => {
    await expect(
      loadSpec({ info: { title: "Old" }, paths: {}, swagger: "2.0" }),
    ).rejects.toThrow(/OpenAPI 3\.x documents only \(found Swagger 2\.0\)/);
  });

  it("rejects a document with no recognisable version", async () => {
    await expect(loadSpec({ paths: {} })).rejects.toThrow(
      /no recognisable version field/,
    );
  });

  it("accepts OpenAPI 3.1", async () => {
    const { document } = await loadSpec({
      ...minimalDocument,
      openapi: "3.1.0",
    });

    expect(document.openapi).toBe("3.1.0");
  });

  it("bundles a YAML document split across files", async () => {
    const { document } = await loadSpec(MULTI_FILE_SPEC);

    const body = document.paths?.["/pets"]?.post?.requestBody;
    const schema =
      body && "content" in body
        ? body.content?.["application/json"]?.schema
        : undefined;

    // The external file's own internal `$ref` has to resolve too, so `tag`
    // arrives as a local pointer rather than a dangling `./resources/...`.
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).not.toMatch(/resources\/pets\.yaml/);
  });
});
