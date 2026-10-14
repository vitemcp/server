/**
 * `embedded()` resolves a resource the way `resources/read` does.
 *
 * A loader may name the `uri` of what it returns — the canonical address
 * behind an alias, say — and `resources/read` keeps it. `embedded()` replaced
 * it with the URI it was asked for, so one resource went out under two
 * identities depending on how the client came by it.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { ViteMCP } from "./ViteMCP.js";

describe("embedded()", () => {
  it("keeps the uri a resource loader returns", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResource({
      load: async () => ({ text: "{}", uri: "docs://canonical" }),
      mimeType: "application/json",
      name: "Alias",
      uri: "docs://alias",
    });

    expect(await server.embedded("docs://alias")).toEqual({
      mimeType: "application/json",
      text: "{}",
      uri: "docs://canonical",
    });
  });

  it("keeps the uri a resource template loader returns", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResourceTemplate({
      arguments: [{ name: "id" }],
      load: async ({ id }) => ({
        text: `record ${id}`,
        uri: `docs://records/${id}/latest`,
      }),
      mimeType: "text/plain",
      name: "Record",
      uriTemplate: "docs://records/{id}",
    });

    expect(await server.embedded("docs://records/42")).toEqual({
      mimeType: "text/plain",
      text: "record 42",
      uri: "docs://records/42/latest",
    });
  });

  it("fills in the requested uri when the loader names none", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResource({
      load: async () => ({ text: "up" }),
      mimeType: "text/plain",
      name: "Status",
      uri: "system://status",
    });

    expect(await server.embedded("system://status")).toEqual({
      mimeType: "text/plain",
      text: "up",
      uri: "system://status",
    });
  });

  /**
   * `embedded()` matched templates with a library of its own, which let a
   * simple `{id}` take a `/` where `resources/read` does not: the same URI
   * reached a different template, with different arguments, depending on how
   * it was asked for.
   */
  describe("matching a resource template", () => {
    it("does not let a broader template claim a more specific one's URI", async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });

      server.addResourceTemplate({
        arguments: [{ name: "id" }],
        load: async ({ id }) => ({ text: `doc ${id}` }),
        name: "Doc",
        uriTemplate: "docs://{id}",
      });
      server.addResourceTemplate({
        arguments: [{ name: "id" }],
        load: async ({ id }) => ({ text: `history of ${id}` }),
        name: "History",
        uriTemplate: "docs://{id}/history",
      });

      expect(await server.embedded("docs://x/history")).toMatchObject({
        text: "history of x",
      });
      expect(await server.embedded("docs://x")).toMatchObject({
        text: "doc x",
      });
    });

    it("does not hand a simple variable more than one path segment", async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });
      const load = vi.fn(async ({ name }: Record<string, string>) => ({
        text: `log ${name}`,
      }));

      server.addResourceTemplate({
        arguments: [{ name: "name" }],
        load,
        name: "Logs",
        uriTemplate: "file:///logs/{name}.log",
      });

      // The loader was handed `name: "../../etc/passwd"`.
      await expect(
        server.embedded("file:///logs/../../etc/passwd.log"),
      ).rejects.toThrow("Resource not found");
      expect(load).not.toHaveBeenCalled();
    });

    it("still lets a reserved expansion span path segments", async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });

      server.addResourceTemplate({
        arguments: [{ name: "path" }],
        load: async ({ path }) => ({ text: `file ${path}` }),
        name: "Files",
        uriTemplate: "file:///{+path}",
      });

      expect(await server.embedded("file:///a/b/c.txt")).toMatchObject({
        text: "file a/b/c.txt",
      });
    });

    it("hands the loader the arguments resources/read would", async () => {
      const server = new ViteMCP({ name: "Test", version: "1.0.0" });
      const load = vi.fn(async () => ({ text: "doc" }));

      server.addResourceTemplate({
        arguments: [{ name: "id" }],
        load,
        name: "Doc",
        uriTemplate: "docs://{id}",
      });

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

      await client.readResource({ uri: "docs://a%20b" });
      await server.embedded("docs://a%20b");

      await client.close();

      const [[viaRead], [viaEmbedded]] = load.mock.calls as unknown as [
        [Record<string, string>],
        [Record<string, string>],
      ];

      expect(viaEmbedded).toEqual(viaRead);
    });
  });
});
