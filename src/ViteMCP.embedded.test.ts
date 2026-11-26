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
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
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

/**
 * A loader only ever got a context built outside any request, so one that
 * scoped what it returned to the caller served every tool that embedded it the
 * anonymous version, though the tool itself knew the caller.
 */
describe("embedded() with the calling tool's context", () => {
  type Session = { role: "admin" | "user"; userId: string };

  const admin = (auth: Session | undefined) => auth?.role === "admin";

  /** Every caller is `u1`, a user: what `canAccess` is checked against. */
  const createServer = () => {
    const server = new ViteMCP<Session>({
      authenticate: async () => ({ role: "user", userId: "u1" }),
      name: "Test",
      version: "1.0.0",
    });

    server.addResource({
      load: async (context) => ({ text: `profile of ${context.auth?.userId}` }),
      mimeType: "text/plain",
      name: "Profile",
      uri: "user://me",
    });
    server.addResourceTemplate({
      arguments: [{ name: "id" }],
      load: async ({ id }, context) => ({
        text: `note ${id} of ${context.auth?.userId}`,
      }),
      mimeType: "text/plain",
      name: "Note",
      uriTemplate: "notes://{id}",
    });
    server.addResource({
      canAccess: admin,
      load: async () => ({ text: "dossier" }),
      mimeType: "text/plain",
      name: "Dossier",
      uri: "admin://dossier",
    });
    server.addResourceTemplate({
      arguments: [{ name: "id" }],
      canAccess: admin,
      load: async ({ id }) => ({ text: `record ${id}` }),
      mimeType: "text/plain",
      name: "Record",
      uriTemplate: "admin://records/{id}",
    });
    server.addTool({
      description: "Embeds the resource at a URI",
      execute: async ({ uri, withContext }, context) => ({
        content: [
          {
            resource: await server.embedded(
              uri,
              withContext ? context : undefined,
            ),
            type: "resource",
          },
        ],
      }),
      name: "embed",
      parameters: z.object({ uri: z.string(), withContext: z.boolean() }),
    });

    return server;
  };

  const embed = async (client: Client, uri: string, withContext: boolean) =>
    (await client.callTool({
      arguments: { uri, withContext },
      name: "embed",
    })) as {
      content: Array<{ resource?: { text: string }; text?: string }>;
      isError?: boolean;
    };

  const textOf = async (client: Client, uri: string, withContext: boolean) => {
    const result = await embed(client, uri, withContext);

    expect(result.isError).toBeFalsy();

    return result.content[0].resource?.text;
  };

  it("hands a resource loader the caller's auth", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(await textOf(client, "user://me", true)).toBe("profile of u1");
      },
      server: createServer,
    });
  });

  it("hands a resource template loader the caller's auth", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(await textOf(client, "notes://a", true)).toBe("note a of u1");
      },
      server: createServer,
    });
  });

  it("does not reach what canAccess refuses the caller", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        for (const uri of ["admin://dossier", "admin://records/1"]) {
          const result = await embed(client, uri, true);

          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain(
            `Resource not found: ${uri}`,
          );
        }
      },
      server: createServer,
    });
  });

  // Without a caller there is nobody to check, as before: the loader runs
  // outside any request.
  it("loads with no auth, and without consulting canAccess, given no context", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(await textOf(client, "user://me", false)).toBe(
          "profile of undefined",
        );
        expect(await textOf(client, "admin://dossier", false)).toBe("dossier");
      },
      server: createServer,
    });
  });
});
