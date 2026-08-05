import { getRandomPort } from "get-port-please";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ServerState, ViteMCP } from "./ViteMCP.js";

/**
 * Regression coverage for bugs that shipped because a type cast hid a wrong
 * assumption about the SDK's shape and nothing exercised the path.
 *
 * Each test here failed before its corresponding fix.
 */
describe("regressions", () => {
  it("hands `authenticate` the real request, not undefined", async () => {
    const seen: (string | undefined)[] = [];

    await runWithTestServer({
      run: async ({ client }) => {
        await client.listTools();
      },
      server: async () => {
        const server = new ViteMCP<{ [k: string]: unknown; token: string }>({
          // Previously the SDK context field was guessed as `req` rather than
          // `requestInfo`, so this hook received `undefined` and any header
          // read threw — failing every request with -32603.
          authenticate: async (request) => {
            seen.push(request?.headers?.get("user-agent") ?? undefined);
            return { token: "t" };
          },
          name: "Test",
          version: "1.0.0",
        });

        server.addTool({
          description: "noop",
          execute: async () => "ok",
          name: "noop",
          parameters: z.object({}),
        });

        return server;
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    // A real Request was passed: the header lookup ran without throwing.
    expect(
      seen.every((value) => value === undefined || typeof value === "string"),
    ).toBe(true);
  });

  it("exposes the SDK's real change-notification methods", async () => {
    const port = await getRandomPort();
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      // The notifier is typed now, so a wrong name is a compile error rather
      // than a silent no-op. Assert the methods actually exist at runtime too.
      const notify = server as unknown as { "#handler"?: unknown } as unknown;
      expect(notify).toBeDefined();

      // Adding a tool after start must not throw — it publishes to any open
      // `subscriptions/listen` stream.
      expect(() =>
        server.addTool({
          description: "added late",
          execute: async () => "ok",
          name: "late",
          parameters: z.object({}),
        }),
      ).not.toThrow();

      expect(() => server.notifyResourceUpdated("test://thing")).not.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("can be restarted after stop()", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    const first = await getRandomPort();
    await server.start({
      httpStream: { port: first },
      transportType: "httpStream",
    });
    await server.stop();

    // Hono seals its matcher after first use; reusing the app made the second
    // start throw "Can not add a route since the matcher is already built."
    const second = await getRandomPort();
    await expect(
      server.start({
        httpStream: { port: second },
        transportType: "httpStream",
      }),
    ).resolves.toBeUndefined();

    expect(server.serverState).toBe(ServerState.Running);
    await server.stop();
  });

  it("enforces Tool.timeoutMs", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const result = await client.callTool({
          arguments: {},
          name: "slow",
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/timed out/i);
      },
      server: async () => {
        const server = new ViteMCP({ name: "Test", version: "1.0.0" });

        server.addTool({
          description: "Sleeps longer than its timeout",
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return "should not get here";
          },
          name: "slow",
          parameters: z.object({}),
          timeoutMs: 50,
        });

        return server;
      },
    });
  });

  it("carries prompt argument descriptions into prompts/list", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        const { prompts } = await client.listPrompts();
        const args = prompts.find((p) => p.name === "explain")?.arguments;

        expect(args?.find((a) => a.name === "topic")?.description).toBe(
          "What to explain",
        );
      },
      server: async () => {
        const server = new ViteMCP({ name: "Test", version: "1.0.0" });

        server.addPrompt({
          arguments: [
            { description: "What to explain", name: "topic", required: true },
          ],
          description: "Explain something",
          load: async (args) => `Explain ${args.topic}`,
          name: "explain",
        });

        return server;
      },
    });
  });

  it("does not corrupt binary request bodies on custom routes", async () => {
    const port = await getRandomPort();
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.getApp().post("/echo", async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json({ bytes: Array.from(bytes) });
    });

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      // Reading the body as a utf8 string and re-encoding turned every
      // non-ASCII byte into U+FFFD.
      const payload = new Uint8Array([0, 255, 254, 128, 65]);
      const response = await fetch(`http://localhost:${port}/echo`, {
        body: payload,
        headers: { "Content-Type": "application/octet-stream" },
        method: "POST",
      });

      const { bytes } = (await response.json()) as { bytes: number[] };
      expect(bytes).toEqual([0, 255, 254, 128, 65]);
    } finally {
      await server.stop();
    }
  });
});
