import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ServerState, ViteMCP } from "./ViteMCP.js";

/**
 * The 2025-era version of this file drove the v1 `StdioServerTransport` and
 * asserted stdin listener add/remove behaviour. That plumbing now lives inside
 * the SDK's `serveStdio`, so testing it here would be testing the SDK. What
 * remains ViteMCP's own responsibility is the start/stop lifecycle.
 */
describe("stdio transport lifecycle", () => {
  it("starts and reports running state", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addTool({
      description: "Add two numbers",
      execute: async (args) => String(args.a + args.b),
      name: "add",
      parameters: z.object({ a: z.number(), b: z.number() }),
    });

    await server.start({ transportType: "stdio" });
    expect(server.serverState).toBe(ServerState.Running);

    await server.stop();
    expect(server.serverState).toBe(ServerState.Stopped);
  });

  it("stop() is safe to call without a prior start", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.serverState).toBe(ServerState.Stopped);
  });

  it("stop() is idempotent", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    await server.start({ transportType: "stdio" });
    await server.stop();

    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.serverState).toBe(ServerState.Stopped);
  });
});
