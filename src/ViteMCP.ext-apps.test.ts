/**
 * Tests for MCP ext-apps _meta field support (issue #229)
 *
 * These tests verify that the _meta field is properly passed through
 * in tool listings, enabling MCP ext-apps interactive UI components.
 *
 * @see https://github.com/punkpeye/vitemcp/issues/229
 * @see https://modelcontextprotocol.github.io/ext-apps/
 */
import { expect, test } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

test("includes _meta.ui.resourceUri in tool listing", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        _meta: {
          ui: {
            resourceUri: "ui://greet-user/app.html",
          },
        },
        description: "Greet a user with interactive UI",
        name: "greet-user",
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        _meta: {
          ui: {
            resourceUri: "ui://greet-user/app.html",
          },
        },
        description: "Greet a user with interactive UI",
        execute: async (args) => {
          return `Hello, ${args.name}!`;
        },
        name: "greet-user",
        parameters: z.object({
          name: z.string(),
        }),
      });

      return server;
    },
  });
});

test("tool without _meta works correctly", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({
        description: "Add two numbers",
        name: "add",
      });
      // _meta should not be present
      expect(result.tools[0]).not.toHaveProperty("_meta");
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        description: "Add two numbers",
        execute: async (args) => {
          return String(args.a + args.b);
        },
        name: "add",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
      });

      return server;
    },
  });
});

test("preserves arbitrary _meta fields", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]._meta).toEqual({
        customField: "custom-value",
        nested: {
          deep: true,
        },
        ui: {
          resourceUri: "ui://custom-tool/app.html",
        },
        version: 2,
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        _meta: {
          customField: "custom-value",
          nested: {
            deep: true,
          },
          ui: {
            resourceUri: "ui://custom-tool/app.html",
          },
          version: 2,
        },
        description: "Tool with custom metadata",
        execute: async () => {
          return "result";
        },
        name: "custom-tool",
      });

      return server;
    },
  });
});

test("multiple tools with and without _meta", async () => {
  await runWithTestServer({
    run: async ({ client }) => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(3);

      // Tool with _meta
      const toolWithMeta = result.tools.find((t) => t.name === "tool-with-ui");
      expect(toolWithMeta?._meta).toEqual({
        ui: { resourceUri: "ui://tool-with-ui/app.html" },
      });

      // Tool without _meta
      const toolWithoutMeta = result.tools.find(
        (t) => t.name === "tool-without-ui",
      );
      expect(toolWithoutMeta).not.toHaveProperty("_meta");

      // Another tool with different _meta
      const anotherTool = result.tools.find(
        (t) => t.name === "another-ui-tool",
      );
      expect(anotherTool?._meta).toEqual({
        category: "dashboard",
        ui: { resourceUri: "ui://another/dashboard.html" },
      });
    },
    server: async () => {
      const server = new ViteMCP({
        name: "Test",
        version: "1.0.0",
      });

      server.addTool({
        _meta: {
          ui: { resourceUri: "ui://tool-with-ui/app.html" },
        },
        description: "Tool with UI",
        execute: async () => "result",
        name: "tool-with-ui",
      });

      server.addTool({
        description: "Tool without UI",
        execute: async () => "result",
        name: "tool-without-ui",
      });

      server.addTool({
        _meta: {
          category: "dashboard",
          ui: { resourceUri: "ui://another/dashboard.html" },
        },
        description: "Another tool with UI",
        execute: async () => "result",
        name: "another-ui-tool",
      });

      return server;
    },
  });
});
