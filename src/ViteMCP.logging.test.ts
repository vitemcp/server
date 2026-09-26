import type { Client } from "@modelcontextprotocol/client";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

/** A server whose one tool logs once through each `log` method. */
const withChattyTool = () => {
  const server = new ViteMCP({ name: "Test", version: "1.0.0" });

  server.addTool({
    execute: async (_args, { log }) => {
      log.debug("debug line");
      log.info("info line", { step: 1 });
      log.warn("warn line");
      log.error("error line");

      return "done";
    },
    name: "chatty",
    parameters: z.object({}),
  });

  return server;
};

/**
 * Calls the tool, opting in at `logLevel` when one is given, and returns the
 * log notifications that arrived with the call.
 */
const logsFrom = async (client: Client, logLevel?: string) => {
  const received: { data: unknown; level: string }[] = [];

  client.setNotificationHandler("notifications/message", ({ params }) => {
    received.push({ data: params.data, level: params.level });
  });

  await client.callTool({
    _meta: logLevel ? { "io.modelcontextprotocol/logLevel": logLevel } : {},
    arguments: {},
    name: "chatty",
  });

  return received;
};

describe("context.log", () => {
  it("sends nothing to a request that did not ask for logs", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(await logsFrom(client)).toEqual([]);
      },
      server: withChattyTool,
    });
  });

  // Nothing arrived here either, once: the level was read from `_meta`, which
  // the SDK strips of it, and the SDK refuses to send a log line for a server
  // that does not declare `logging`.
  it("sends every level to a request that asks for debug", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(client.getServerCapabilities()?.logging).toEqual({});

        expect(await logsFrom(client, "debug")).toEqual([
          { data: { message: "debug line" }, level: "debug" },
          {
            data: { context: { step: 1 }, message: "info line" },
            level: "info",
          },
          { data: { message: "warn line" }, level: "warning" },
          { data: { message: "error line" }, level: "error" },
        ]);
      },
      server: withChattyTool,
    });
  });

  it("sends only the requested level and those above it", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const levels = async (logLevel: string) =>
          (await logsFrom(client, logLevel)).map(({ level }) => level);

        expect(await levels("warning")).toEqual(["warning", "error"]);
        expect(await levels("error")).toEqual(["error"]);
        // A level `log` has no method for still sets the floor.
        expect(await levels("notice")).toEqual(["warning", "error"]);
        expect(await levels("critical")).toEqual([]);
      },
      server: withChattyTool,
    });
  });
});
