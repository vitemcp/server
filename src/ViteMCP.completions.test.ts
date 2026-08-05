import { describe, expect, it } from "vitest";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

describe("ViteMCP Completions", () => {
  it("supports prompt completions", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addPrompt({
      arguments: [
        {
          description: "First argument",
          name: "arg1",
        },
      ],
      complete: async (name, value) => {
        if (name === "arg1" && value === "abc") {
          return {
            values: ["abc1", "abc2"],
          };
        }
        return {
          values: [],
        };
      },
      load: async () => ({
        messages: [],
      }),
      name: "test-prompt",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "arg1",
            value: "abc",
          },
          ref: {
            name: "test-prompt",
            type: "ref/prompt",
          },
        });

        expect(result.completion.values).toEqual(["abc1", "abc2"]);
      },
      server,
    });
  });

  it("supports resource completions", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addResourceTemplate({
      arguments: [{ name: "id", required: true }],
      complete: async (_name, value) => ({
        values: ["1", "2"].filter((v) => v.startsWith(value)),
      }),
      load: async () => ({
        text: "content",
        uri: "test://resource/1",
      }),
      name: "test-resource",
      uriTemplate: "test://resource/{id}",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "id",
            value: "1",
          },
          ref: {
            type: "ref/resource",
            uri: "test://resource/{id}",
          },
        });

        expect(result.completion.values).toEqual(["1"]);
      },
      server,
    });
  });

  it("prioritizes argument-level completion over prompt-level completion", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });
    server.addPrompt({
      arguments: [
        {
          complete: async (value) => ({
            values: [`arg-level-${value}`],
          }),
          name: "arg1",
        },
      ],
      complete: async (_name, value) => ({
        values: [`prompt-level-${value}`],
      }),
      load: async () => ({ messages: [] }),
      name: "priority-test",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.complete({
          argument: {
            name: "arg1",
            value: "abc",
          },
          ref: {
            name: "priority-test",
            type: "ref/prompt",
          },
        });

        expect(result.completion.values).toEqual(["arg-level-abc"]);
      },
      server,
    });
  });

  it("throws error for unknown prompt", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.complete({
            argument: {
              name: "arg",
              value: "val",
            },
            ref: {
              name: "unknown-prompt",
              type: "ref/prompt",
            },
          }),
        ).rejects.toThrow();
      },
    });
  });

  it("throws error for unknown resource", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.complete({
            argument: {
              name: "arg",
              value: "val",
            },
            ref: {
              type: "ref/resource",
              uri: "unknown://uri",
            },
          }),
        ).rejects.toThrow();
      },
    });
  });
});
