/**
 * Prompt arguments named like a member of `Object.prototype`.
 *
 * Zod reads an argument through the prototype chain, so one the client left
 * out but `Object.prototype` has — `toString`, `constructor`, `valueOf` —
 * arrived as a function: an optional one could never be left out, and a
 * required one was reported as the wrong type instead of as missing.
 */
import { ProtocolErrorCode } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

const NAMES = ["toString", "constructor", "valueOf", "hasOwnProperty"];

describe("a prompt argument named like a member of Object.prototype", () => {
  it("can be left out when it is optional", async () => {
    const received: unknown[] = [];
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    for (const name of NAMES) {
      server.addPrompt({
        arguments: [{ name }],
        load: async (args) => {
          received.push(args);
          return "ok";
        },
        name: `with-${name}`,
      });
    }

    await runWithTestServer({
      run: async ({ client }) => {
        for (const name of NAMES) {
          await client.getPrompt({ arguments: {}, name: `with-${name}` });
        }
      },
      server,
    });

    expect(received).toEqual(NAMES.map(() => ({})));
  });

  it("is reported missing when it is required", async () => {
    const load = vi.fn(async () => "ok");
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addPrompt({
      arguments: [{ name: "constructor", required: true }],
      load,
      name: "build",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.getPrompt({ arguments: {}, name: "build" }),
        ).rejects.toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
          message: expect.not.stringContaining("received function"),
        });
      },
      server,
    });

    expect(load).not.toHaveBeenCalled();
  });

  it("arrives as sent, and is still listed and completed", async () => {
    const received: unknown[] = [];
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addPrompt({
      arguments: [{ enum: ["json", "text"], name: "toString", required: true }],
      load: async (args) => {
        received.push(args);
        return "ok";
      },
      name: "render",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await client.getPrompt({
          arguments: { toString: "json" },
          name: "render",
        });

        const { prompts } = await client.listPrompts();

        expect(prompts[0].arguments).toEqual([
          { name: "toString", required: true },
        ]);

        const { completion } = await client.complete({
          argument: { name: "toString", value: "j" },
          ref: { name: "render", type: "ref/prompt" },
        });

        expect(completion.values).toEqual(["json"]);
      },
      server,
    });

    expect(received).toEqual([{ toString: "json" }]);
  });
});

// `prompts/get` may leave `arguments` out, and the SDK validates the map as it
// was sent: a prompt whose arguments were all optional refused the request as
// "expected object, received undefined".
describe("a prompt called without an argument map", () => {
  it("is handed an empty one", async () => {
    const received: unknown[] = [];
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addPrompt({
      arguments: [{ name: "topic" }],
      load: async (args) => {
        received.push(args);
        return `Outline ${args.topic ?? "anything"}.`;
      },
      name: "outline",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.getPrompt({ name: "outline" });

        expect(result.messages[0].content).toEqual({
          text: "Outline anything.",
          type: "text",
        });
      },
      server,
    });

    expect(received).toEqual([{}]);
  });

  it("reports a required argument missing, rather than the map", async () => {
    const load = vi.fn(async () => "ok");
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addPrompt({
      arguments: [{ name: "topic", required: true }],
      load,
      name: "outline",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await expect(
          client.getPrompt({ name: "outline" }),
        ).rejects.toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
          message: expect.stringContaining("topic"),
        });
      },
      server,
    });

    expect(load).not.toHaveBeenCalled();
  });
});
