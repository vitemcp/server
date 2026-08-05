import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ContentResult, ViteMCP } from "./ViteMCP.js";

/**
 * Connects a client to a server over a linked in-memory transport pair, the
 * pattern documented in the README's "Testing your server" section.
 */
const connectInMemory = async (server: ViteMCP) => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    // In-memory transports negotiate like any other; without this the client
    // speaks the 2025 era.
    { versionNegotiation: { mode: "auto" } },
  );

  const [session] = await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, session };
};

describe("ViteMCP in-memory transport", () => {
  it("serves tools registered on the ViteMCP instance", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: z.object({ a: z.number(), b: z.number() }),
    });

    const { client } = await connectInMemory(server);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "add",
    ]);

    const result = (await client.callTool({
      arguments: { a: 2, b: 3 },
      name: "add",
    })) as ContentResult;

    expect(result).toEqual({ content: [{ text: "5", type: "text" }] });

    await client.close();
  });

  it("serves resources and prompts", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResource({
      async load() {
        return { text: "log contents" };
      },
      mimeType: "text/plain",
      name: "Logs",
      uri: "file:///logs/app.log",
    });

    server.addPrompt({
      arguments: [{ name: "name", required: true }],
      description: "Greet someone",
      load: async (args) => `Hello, ${args.name}!`,
      name: "greet",
    });

    const { client } = await connectInMemory(server);

    expect((await client.listResources()).resources[0].uri).toBe(
      "file:///logs/app.log",
    );

    const contents = (await client.readResource({
      uri: "file:///logs/app.log",
    })) as { contents: Array<{ text: string }> };

    expect(contents.contents[0].text).toBe("log contents");

    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      "greet",
    ]);

    const prompt = (await client.getPrompt({
      arguments: { name: "World" },
      name: "greet",
    })) as { messages: Array<{ content: { text: string } }> };

    expect(prompt.messages[0].content.text).toBe("Hello, World!");

    await client.close();
  });
});
