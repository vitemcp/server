import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer, withoutEnvelope } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

// Suppress AbortError from MCP SDK during test cleanup
const originalUnhandledRejection: Array<
  (reason: unknown, promise: Promise<unknown>) => void
> = [];

beforeAll(() => {
  // Store existing listeners
  const listeners = process.listeners("unhandledRejection");
  originalUnhandledRejection.push(
    ...(listeners as Array<
      (reason: unknown, promise: Promise<unknown>) => void
    >),
  );

  // Replace with our handler
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason: unknown) => {
    // Ignore AbortError from SSE client during cleanup
    if (
      reason instanceof Error &&
      (reason.name === "AbortError" || reason.message?.includes("aborted"))
    ) {
      return;
    }
    // Re-throw other errors
    throw reason;
  });
});

afterAll(() => {
  // Restore original listeners
  process.removeAllListeners("unhandledRejection");
  originalUnhandledRejection.forEach((listener) => {
    process.on("unhandledRejection", listener);
  });
});

describe("ViteMCP Batch Methods", () => {
  const createTestServer = () => {
    return new ViteMCP({
      name: "test-server",
      version: "1.0.0",
    });
  };

  describe("addPrompts", () => {
    it("should add multiple prompts", async () => {
      const server = createTestServer();

      const prompts = [
        {
          description: "Test prompt 1",
          load: async () => "Test response 1",
          name: "prompt1",
        },
        {
          description: "Test prompt 2",
          load: async () => "Test response 2",
          name: "prompt2",
        },
      ];

      expect(() => server.addPrompts(prompts)).not.toThrow();
    });
  });

  describe("removePrompts", () => {
    it("should remove multiple prompts", async () => {
      const server = createTestServer();

      // Add some prompts first
      const prompts = [
        {
          description: "Test prompt 1",
          load: async () => "Test response 1",
          name: "prompt1",
        },
        {
          description: "Test prompt 2",
          load: async () => "Test response 2",
          name: "prompt2",
        },
        {
          description: "Test prompt 3",
          load: async () => "Test response 3",
          name: "prompt3",
        },
      ];

      server.addPrompts(prompts);

      expect(() => server.removePrompts(["prompt1", "prompt3"])).not.toThrow();
    });
  });

  describe("addTools", () => {
    it("should add multiple tools using addTool individually", async () => {
      const server = createTestServer();

      const tool1 = {
        description: "Test tool 1",
        execute: async () => "Tool 1 result",
        name: "tool1",
      };

      const tool2 = {
        description: "Test tool 2",
        execute: async () => "Tool 2 result",
        name: "tool2",
      };

      // Add them individually to avoid type issues
      expect(() => {
        server.addTool(tool1);
        server.addTool(tool2);
      }).not.toThrow();
    });

    it("should add multiple tools of same type", async () => {
      const server = createTestServer();

      const tools = [
        {
          description: "Calculator tool 1",
          execute: async ({ a, b }: { a: number; b: number }) => `${a + b}`,
          name: "calculator1",
          parameters: z.object({ a: z.number(), b: z.number() }),
        },
        {
          description: "Calculator tool 2",
          execute: async ({ a, b }: { a: number; b: number }) => `${a * b}`,
          name: "calculator2",
          parameters: z.object({ a: z.number(), b: z.number() }),
        },
      ];

      expect(() => server.addTools(tools)).not.toThrow();
    });
  });

  describe("removeTools", () => {
    it("should remove multiple tools", async () => {
      const server = createTestServer();

      const tools = [
        {
          description: "Test tool 1",
          execute: async () => "Tool 1",
          name: "tool1",
        },
        {
          description: "Test tool 2",
          execute: async () => "Tool 2",
          name: "tool2",
        },
        {
          description: "Test tool 3",
          execute: async () => "Tool 3",
          name: "tool3",
        },
      ];

      // Add them first
      for (const tool of tools) {
        server.addTool(tool);
      }

      expect(() => server.removeTools(["tool1", "tool3"])).not.toThrow();
    });
  });

  describe("addResources", () => {
    it("should add multiple resources", async () => {
      const server = createTestServer();

      const resources = [
        {
          description: "Test resource 1",
          load: async () => ({ text: "Resource 1 content" }),
          name: "resource1",
          uri: "test://resource1",
        },
        {
          description: "Test resource 2",
          load: async () => ({ text: "Resource 2 content" }),
          name: "resource2",
          uri: "test://resource2",
        },
      ];

      expect(() => server.addResources(resources)).not.toThrow();
    });
  });

  describe("removeResources", () => {
    it("should remove multiple resources", async () => {
      const server = createTestServer();

      const resources = [
        {
          load: async () => ({ text: "Resource 1" }),
          name: "resource1",
          uri: "test://resource1",
        },
        {
          load: async () => ({ text: "Resource 2" }),
          name: "resource2",
          uri: "test://resource2",
        },
        {
          load: async () => ({ text: "Resource 3" }),
          name: "resource3",
          uri: "test://resource3",
        },
      ];

      server.addResources(resources);

      expect(() =>
        server.removeResources(["resource1", "resource3"]),
      ).not.toThrow();
    });
  });

  describe("addResourceTemplates", () => {
    it("should add multiple resource templates", async () => {
      const server = createTestServer();

      const template1 = {
        arguments: [{ description: "Resource ID", name: "id", required: true }],
        description: "Test template 1",
        load: async (args: Record<string, unknown>) => ({
          text: `Template 1 content for ${args.id}`,
        }),
        name: "template1",
        uriTemplate: "test://template1/{id}",
      };

      const template2 = {
        arguments: [
          { description: "Resource slug", name: "slug", required: true },
        ],
        description: "Test template 2",
        load: async (args: Record<string, unknown>) => ({
          text: `Template 2 content for ${args.slug}`,
        }),
        name: "template2",
        uriTemplate: "test://template2/{slug}",
      };

      expect(() => {
        server.addResourceTemplate(template1);
        server.addResourceTemplate(template2);
      }).not.toThrow();
    });
  });

  describe("removeResourceTemplates", () => {
    it("should remove multiple resource templates", async () => {
      const server = createTestServer();

      const template1 = {
        arguments: [{ name: "id", required: true }],
        load: async (args: Record<string, unknown>) => ({
          text: `Template 1: ${args.id}`,
        }),
        name: "template1",
        uriTemplate: "test://template1/{id}",
      };

      const template2 = {
        arguments: [{ name: "id", required: true }],
        load: async (args: Record<string, unknown>) => ({
          text: `Template 2: ${args.id}`,
        }),
        name: "template2",
        uriTemplate: "test://template2/{id}",
      };

      const template3 = {
        arguments: [{ name: "id", required: true }],
        load: async (args: Record<string, unknown>) => ({
          text: `Template 3: ${args.id}`,
        }),
        name: "template3",
        uriTemplate: "test://template3/{id}",
      };

      // Add them first
      server.addResourceTemplate(template1);
      server.addResourceTemplate(template2);
      server.addResourceTemplate(template3);

      expect(() =>
        server.removeResourceTemplates(["template1", "template3"]),
      ).not.toThrow();
    });
  });

  // The SDK refuses to register a name or URI twice, and the server is built
  // for every request, so an entry added again — in a batch or on its own —
  // failed every request with a 500, not only requests for that entry.
  describe("adding an entry again under the same key", () => {
    it("replaces a tool of the same name", async () => {
      const server = createTestServer();
      const tool = (version: string) => ({
        description: version,
        execute: async () => version,
        name: "greet",
      });

      server.addTools([tool("v1"), tool("v2")]);
      server.addTool(tool("v3"));

      await runWithTestServer({
        run: async ({ client }) => {
          const { tools } = await client.listTools();
          expect(tools.map((listed) => listed.description)).toEqual(["v3"]);

          expect(
            withoutEnvelope(await client.callTool({ name: "greet" })),
          ).toEqual({ content: [{ text: "v3", type: "text" }] });
        },
        server,
      });
    });

    it("replaces a prompt of the same name", async () => {
      const server = createTestServer();
      const prompt = (version: string) => ({
        description: version,
        load: async () => version,
        name: "brief",
      });

      server.addPrompts([prompt("v1"), prompt("v2")]);
      server.addPrompt(prompt("v3"));

      await runWithTestServer({
        run: async ({ client }) => {
          const { prompts } = await client.listPrompts();
          expect(prompts.map((listed) => listed.description)).toEqual(["v3"]);

          const { messages } = await client.getPrompt({ name: "brief" });
          expect(messages).toEqual([
            { content: { text: "v3", type: "text" }, role: "user" },
          ]);
        },
        server,
      });
    });

    // By URI, since that is what the SDK registers a resource by: a resource
    // that only shares a name is a different resource.
    it("replaces a resource of the same URI", async () => {
      const server = createTestServer();
      const resource = (version: string) => ({
        load: async () => ({ text: version }),
        name: version,
        uri: "test://greeting",
      });

      server.addResources([resource("v1"), resource("v2")]);
      server.addResource(resource("v3"));

      await runWithTestServer({
        run: async ({ client }) => {
          const { resources } = await client.listResources();
          expect(resources.map((listed) => listed.name)).toEqual(["v3"]);

          const { contents } = await client.readResource({
            uri: "test://greeting",
          });
          expect(contents).toEqual([{ text: "v3", uri: "test://greeting" }]);
        },
        server,
      });
    });

    it("replaces a resource template of the same name", async () => {
      const server = createTestServer();
      const template = (version: string) => ({
        arguments: [{ name: "id", required: true }],
        load: async () => ({ text: version }),
        name: "greeting",
        uriTemplate: `test://${version}/{id}`,
      });

      server.addResourceTemplates([template("v1"), template("v2")]);
      server.addResourceTemplate(template("v3"));

      await runWithTestServer({
        run: async ({ client }) => {
          const { resourceTemplates } = await client.listResourceTemplates();
          expect(resourceTemplates.map((listed) => listed.uriTemplate)).toEqual(
            ["test://v3/{id}"],
          );

          const { contents } = await client.readResource({
            uri: "test://v3/1",
          });
          expect(contents).toEqual([{ text: "v3", uri: "test://v3/1" }]);
        },
        server,
      });
    });
  });
});
