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
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

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
