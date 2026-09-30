/**
 * Tools declared without `parameters` and prompts declared without
 * `arguments` — the README's "Tools Without Parameters", option 1.
 *
 * The SDK passes a handler its arguments only when the primitive declares a
 * schema; without one it calls the handler with the request context alone.
 * Registering one two-argument handler either way put that context where
 * `args` belongs and left nothing in the context's own slot, so such a tool
 * was handed the SDK's request object as its arguments, reported no progress,
 * logged nothing, had no request id and was never told its caller had gone.
 */
import { describe, expect, it, vi } from "vitest";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

describe("a tool without parameters", () => {
  it("is handed no arguments, not the SDK's request context", async () => {
    const received: unknown[] = [];
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (args) => {
        received.push(args);
        return "ok";
      },
      name: "status",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await client.callTool({ arguments: {}, name: "status" });
        // A client may leave `arguments` out altogether for such a tool.
        await client.callTool({ name: "status" });
      },
      server,
    });

    expect(received).toEqual([undefined, undefined]);
  });

  it("gets a context bound to its request", async () => {
    let requestId: unknown;
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (_args, context) => {
        requestId = context.requestId;
        await context.reportProgress({ progress: 1, total: 2 });
        context.log.info("halfway");
        return "ok";
      },
      name: "status",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const onProgress = vi.fn();
        const logged: unknown[] = [];

        client.setNotificationHandler("notifications/message", ({ params }) => {
          logged.push(params.data);
        });

        await client.callTool(
          {
            _meta: { "io.modelcontextprotocol/logLevel": "debug" },
            arguments: {},
            name: "status",
          },
          { onprogress: onProgress },
        );

        expect(onProgress).toHaveBeenCalledWith({ progress: 1, total: 2 });
        expect(logged).toEqual([{ message: "halfway" }]);
      },
      server,
    });

    expect(requestId).toBeDefined();
  });

  it("is told when its caller disconnects", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: (reason: unknown) => void;
    const cancelled = new Promise<unknown>((resolve) => {
      aborted = resolve;
    });

    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      execute: async (_args, context) => {
        started();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted(context.signal.reason);
              resolve();
            },
            { once: true },
          );
        });
        return "cancelled";
      },
      name: "hang",
    });

    await runWithTestServer({
      run: async ({ port }) => {
        const controller = new AbortController();

        // Raw fetch rather than the SDK client: the point is a socket that
        // dies mid-request, which a well-behaved client never does.
        const settled = fetch(`http://localhost:${port}/mcp`, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/protocolVersion":
                  MODERN_PROTOCOL_VERSION,
              },
              arguments: {},
              name: "hang",
            },
          }),
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "hang",
            "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          },
          method: "POST",
          signal: controller.signal,
        }).then(
          () => undefined,
          () => undefined,
        );

        await running;
        controller.abort();

        await settled;
        await expect(cancelled).resolves.toBeDefined();
      },
      server,
    });
  });
});

describe("a prompt without arguments", () => {
  it("is handed an empty argument object, not the SDK's request context", async () => {
    const received: unknown[] = [];
    let requestId: unknown;
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addPrompt({
      load: async (args, context) => {
        received.push(args);
        requestId = context.requestId;
        return "Summarise the last deploy.";
      },
      name: "summary",
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await client.getPrompt({ name: "summary" });
      },
      server,
    });

    expect(received).toEqual([{}]);
    expect(requestId).toBeDefined();
  });
});
