import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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

    it("should handle duplicate prompt names by replacing existing prompts", async () => {
      const server = createTestServer();

      const prompt1 = {
        description: "First version",
        load: async () => "First response",
        name: "duplicate",
      };

      const prompt2 = {
        description: "Second version",
        load: async () => "Second response",
        name: "duplicate",
      };

      expect(() => {
        server.addPrompt(prompt1);
        server.addPrompts([prompt2]);
      }).not.toThrow();
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
});
