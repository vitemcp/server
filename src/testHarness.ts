/**
 * Shared test harness: start a server, point a client at it, run.
 *
 * There is no handshake or session to wait on, and SSE is not used — the
 * streamable endpoint is the only one served.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { ViteMCP } from "./ViteMCP.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type TestRunArgs = {
  client: Client;
  port: number;
  server: ViteMCP<any>;
};

export const runWithTestServer = async ({
  client: createClient,
  run,
  server: createServer,
}: {
  client?: () => Promise<Client>;
  run: (args: TestRunArgs) => Promise<void>;
  /** Either a ready-made server or a factory that builds one. */
  server?: (() => Promise<ViteMCP<any>> | ViteMCP<any>) | ViteMCP<any>;
}): Promise<number> => {
  const server =
    typeof createServer === "function"
      ? await createServer()
      : (createServer ?? new ViteMCP({ name: "Test", version: "1.0.0" }));

  // Bind port 0 so the OS assigns a free port at bind time. Choosing a port
  // up front and binding it later leaves a window for another process — or a
  // parallel test worker — to take it, which surfaces as flaky EADDRINUSE.
  await server.start({
    httpStream: { port: 0 },
    transportType: "httpStream",
  });

  const port = server.port!;

  try {
    const client =
      (await createClient?.()) ??
      new Client(
        { name: "example-client", version: "1.0.0" },
        {
          // The SDK client negotiates the 2025 era unless told otherwise, so
          // without this the whole suite would exercise the legacy path and
          // never touch the 2026-07-28 protocol the server actually targets.
          versionNegotiation: { mode: "auto" },
        },
      );

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );

    await client.connect(transport);

    try {
      await run({ client, port, server });
    } finally {
      await client.close();
    }
  } finally {
    await server.stop();
  }

  return port;
};

/**
 * Strips the 2026-07-28 result envelope (`_meta`, `ttlMs`, `cacheScope`) so
 * payload assertions need not restate spec boilerplate. The envelope itself is
 * covered in `ViteMCP.protocol.test.ts`.
 */
export const withoutEnvelope = <T>(result: T): T => {
  if (Array.isArray(result)) {
    return result.map((entry) => withoutEnvelope(entry)) as T;
  }

  if (!result || typeof result !== "object") {
    return result;
  }

  const stripped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(result)) {
    if (key === "_meta" || key === "ttlMs" || key === "cacheScope") {
      continue;
    }

    stripped[key] = withoutEnvelope(value);
  }

  return stripped as T;
};
