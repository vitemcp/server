/**
 * Cancellation reaching `execute` through `context.signal`.
 *
 * Before this, a tool had no way to observe that its caller had gone: a
 * `timeoutMs` breach rejected the caller while `execute` kept running behind
 * an already-settled promise, and a client that hung up mid-call left the same
 * orphan. On a per-request runtime that work is billed until it finishes.
 *
 * The client-disconnect leg is specifically a Node-transport test. The SDK
 * reads `Request.signal` to tear the exchange down, and `nodeToWebRequest`
 * builds its `Request` by hand — one built without a signal carries one that
 * never fires, so a disconnect was invisible on Node while edge runtimes,
 * which supply their own, saw it.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { type Context, ViteMCP, type ViteMCPAuth } from "./ViteMCP.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
};

/** Resolves with `signal.reason` once the signal aborts. */
const abortReason = (signal: AbortSignal): Promise<unknown> =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason), {
      once: true,
    });
  });

describe("context.signal", () => {
  it("stays unaborted through and after a successful call", async () => {
    let observed: AbortSignal | undefined;
    let abortedDuring = true;
    // The idiom the scoping exists to protect: rollback-on-cancel must not
    // run when the call succeeded.
    let rollbacks = 0;

    const server = new ViteMCP({ name: "Cancellation", version: "1.0.0" });

    server.addTool({
      description: "Records its signal",
      execute: async (_args, context) => {
        observed = context.signal;
        abortedDuring = context.signal.aborted;
        context.signal.addEventListener("abort", () => {
          rollbacks += 1;
        });
        return "ok";
      },
      name: "record",
      parameters: z.object({}),
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await client.callTool({ arguments: {}, name: "record" });
      },
      server,
    });

    expect(observed).toBeInstanceOf(AbortSignal);
    expect(abortedDuring).toBe(false);

    // Asserted after the server has stopped: the SDK aborts its own
    // per-request controller the moment the result is sent, so a `signal`
    // handed straight through would be aborted by now.
    expect(observed!.aborted).toBe(false);
    expect(rollbacks).toBe(0);
  });

  it("stays unaborted after a successful call that had a deadline", async () => {
    let observed: AbortSignal | undefined;

    const server = new ViteMCP({ name: "Cancellation", version: "1.0.0" });

    server.addTool({
      description: "Finishes well inside its deadline",
      execute: async (_args, context) => {
        observed = context.signal;
        return "ok";
      },
      name: "prompt-enough",
      parameters: z.object({}),
      // Long enough that the timer cannot fire during the call, so an abort
      // here could only come from the exchange being torn down.
      timeoutMs: 30_000,
    });

    await runWithTestServer({
      run: async ({ client }) => {
        await client.callTool({ arguments: {}, name: "prompt-enough" });
      },
      server,
    });

    expect(observed!.aborted).toBe(false);
  });

  it("aborts when a tool outruns its timeoutMs", async () => {
    const started = deferred<void>();
    const reason = deferred<unknown>();

    const server = new ViteMCP({ name: "Cancellation", version: "1.0.0" });

    server.addTool({
      description: "Runs until cancelled",
      // Resolves only on abort, so the test asserts the tool actually observed
      // the deadline rather than that the caller stopped waiting.
      execute: async (_args, context) => {
        started.resolve();
        reason.resolve(await abortReason(context.signal));
        return "cancelled";
      },
      name: "slow",
      parameters: z.object({}),
      timeoutMs: 50,
    });

    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.callTool({ arguments: {}, name: "slow" });

        expect(JSON.stringify(result)).toContain("timed out after 50ms");
      },
      server,
    });

    await started.promise;

    // The same error the caller received, so a tool logging `signal.reason`
    // reports the deadline rather than a bare "aborted".
    expect((await reason.promise) as Error).toMatchObject({
      message: "Tool 'slow' timed out after 50ms",
    });
  });

  it("aborts when the client disconnects mid-call", async () => {
    const started = deferred<void>();
    const aborted = deferred<unknown>();

    const server = new ViteMCP({ name: "Cancellation", version: "1.0.0" });

    server.addTool({
      description: "Runs until the caller goes away",
      execute: async (_args, context) => {
        started.resolve();
        aborted.resolve(await abortReason(context.signal));
        return "cancelled";
      },
      name: "hang",
      parameters: z.object({}),
    });

    await runWithTestServer({
      run: async ({ port }) => {
        const controller = new AbortController();

        // Raw fetch rather than the SDK client: the point is a socket that
        // dies mid-request, which a well-behaved client never does.
        const request = fetch(`http://localhost:${port}/mcp`, {
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
        });

        // Catch here, not after the abort: an unhandled rejection between the
        // two would fail the run.
        const settled = request.then(
          () => undefined,
          () => undefined,
        );

        await started.promise;
        controller.abort();

        await settled;
        await expect(aborted.promise).resolves.toBeDefined();
      },
      server,
    });
  });

  it("gives an embedded resource load a signal that never fires", async () => {
    let observed: AbortSignal | undefined;

    const server = new ViteMCP({ name: "Cancellation", version: "1.0.0" });

    server.addResource({
      load: async (context) => {
        observed = context.signal;
        return { text: "body" };
      },
      mimeType: "text/plain",
      name: "note",
      uri: "test://note",
    });

    await server.embedded("test://note");

    // `embedded()` runs outside any request, so there is no source signal to
    // adopt — the placeholder must still be a real, unaborted AbortSignal.
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed!.aborted).toBe(false);
  });
});

/**
 * A request's notifications end with it. Over a transport that outlives the
 * request — stdio, or `connect()` — one sent after the call ended went out
 * anyway, and the client reported a progress update whose token it had let go
 * of as unknown.
 */
describe("notifications after a call ends", () => {
  const connectInMemory = async (server: ViteMCP) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      // Without it the client speaks the 2025 era, which cannot opt in to logs.
      { versionNegotiation: { mode: "auto" } },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return client;
  };

  it.each(["times out", "is cancelled", "returns"] as const)(
    "are dropped once the call %s",
    async (ending) => {
      const finish = deferred<void>();
      let context: Context<ViteMCPAuth> | undefined;

      const server = new ViteMCP({ name: "Notifications", version: "1.0.0" });

      server.addTool({
        execute: async (_args, toolContext) => {
          context = toolContext;
          // Logged first: the progress report is what the cancelling client
          // aborts on.
          toolContext.log.info("during");
          await toolContext.reportProgress({ progress: 0, total: 1 });

          // Still running once its caller has stopped waiting, unless it is
          // the one that ended the call.
          if (ending !== "returns") {
            await finish.promise;
          }

          return "done";
        },
        name: "work",
        parameters: z.object({}),
        ...(ending === "times out" && { timeoutMs: 50 }),
      });

      const client = await connectInMemory(server);
      const controller = new AbortController();
      const errors: string[] = [];
      const logs: unknown[] = [];
      const progress: number[] = [];

      client.onerror = (error) => errors.push(error.message);
      client.setNotificationHandler("notifications/message", ({ params }) => {
        logs.push(params.data);
      });

      await client
        .callTool(
          {
            _meta: { "io.modelcontextprotocol/logLevel": "debug" },
            arguments: {},
            name: "work",
          },
          {
            onprogress: (update) => {
              progress.push(update.progress);

              if (ending === "is cancelled") {
                controller.abort();
              }
            },
            signal: controller.signal,
          },
        )
        .catch(() => undefined);

      // The client stops waiting before the server hears of the cancellation.
      if (!context!.signal.aborted && ending === "is cancelled") {
        await abortReason(context!.signal);
      }

      await context!.reportProgress({ progress: 1, total: 1 });
      context!.log.info("after");
      // Long enough for a notification to cross the in-memory transport.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(progress).toEqual([0]);
      expect(logs).toEqual([{ message: "during" }]);
      expect(errors).toEqual([]);

      finish.resolve();
      await client.close();
    },
  );

  it("resolves a progress report sent after an HTTP call ended, instead of throwing", async () => {
    const finish = deferred<void>();
    const late = deferred<unknown>();

    const server = new ViteMCP({ name: "Notifications", version: "1.0.0" });

    server.addTool({
      execute: async (_args, context) => {
        await finish.promise;
        late.resolve(
          await context.reportProgress({ progress: 1, total: 1 }).then(
            () => "resolved",
            (error: unknown) => error,
          ),
        );

        return "done";
      },
      name: "slow",
      parameters: z.object({}),
      timeoutMs: 50,
    });

    await runWithTestServer({
      run: async ({ client }) => {
        // With `onprogress` the client asks for progress, and sends a token.
        const result = await client.callTool(
          { arguments: {}, name: "slow" },
          { onprogress: () => {} },
        );

        expect(JSON.stringify(result)).toContain("timed out after 50ms");

        finish.resolve();

        // The request's stream closed with the result, so the send threw
        // "Not connected".
        expect(await late.promise).toBe("resolved");
      },
      server,
    });
  });
});
