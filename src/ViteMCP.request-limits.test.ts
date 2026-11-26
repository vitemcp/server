/**
 * The limits on what one request to the MCP endpoint may carry.
 *
 * `maxBodySize` caps the body before anything reads it. The SDK then reads it
 * again under a cap of its own, 4 MiB by default, which a body under a raised
 * `maxBodySize` must not run into.
 *
 * `maxToolInputElements` caps what validating a call can cost, which the body
 * cap does not: half a million invalid elements fit in 1 MiB.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ViteMCP } from "./ViteMCP.js";

const MIB = 1024 * 1024;
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const callTool = (port: number, name: string, args: unknown) =>
  fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
        arguments: args,
        name,
      },
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    },
    method: "POST",
  });

/** Runs `body` against a started server whose tools measure their input. */
const withServer = async (
  config: { maxBodySize?: number; maxToolInputElements?: number },
  body: (port: number, received: number[]) => Promise<void>,
) => {
  const { maxToolInputElements, ...httpStream } = config;
  const received: number[] = [];
  const server = new ViteMCP({
    maxToolInputElements,
    name: "Limits",
    version: "1.0.0",
  });

  server.addTool({
    description: "Reports the size of what it was sent",
    execute: async ({ blob }) => {
      received.push(blob.length);
      return `received ${blob.length}`;
    },
    name: "measure",
    parameters: z.object({ blob: z.string() }),
  });

  server.addTool({
    description: "Reports how many items it was sent",
    execute: async ({ items }) => {
      received.push(items.length);
      return `received ${items.length}`;
    },
    name: "count",
    parameters: z.object({ items: z.array(z.number()) }),
  });

  await server.start({
    httpStream: { enableJsonResponse: true, port: 0, ...httpStream },
    transportType: "httpStream",
  });

  try {
    await body(server.port!, received);
  } finally {
    await server.stop();
  }
};

describe("the MCP endpoint's body size", () => {
  it("accepts a body under a maxBodySize raised past the SDK's 4 MiB", async () => {
    await withServer({ maxBodySize: 8 * MIB }, async (port, received) => {
      const response = await callTool(port, "measure", {
        blob: "x".repeat(5 * MIB),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(received).toEqual([5 * MIB]);
    });
  });
});

describe("the elements a tool call's arguments may hold", () => {
  /** The call's result; `{ items }` counts its one member and each item. */
  const count = async (port: number, items: number) => {
    const response = await callTool(port, "count", {
      items: Array.from({ length: items }, () => 0),
    });

    expect(response.status).toBe(200);

    return (
      (await response.json()) as {
        result: { content: [{ text: string }]; isError?: boolean };
      }
    ).result;
  };

  it("refuses a call over 10,000 by default, before any schema sees it", async () => {
    await withServer({}, async (port, received) => {
      expect((await count(port, 9_999)).isError).toBeFalsy();

      const refused = await count(port, 10_000);

      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(
        "more than the maximum of 10000 elements",
      );
      expect(received).toEqual([9_999]);
    });
  });

  it("admits more once maxToolInputElements is raised", async () => {
    await withServer({ maxToolInputElements: 50_000 }, async (port) => {
      expect((await count(port, 20_000)).isError).toBeFalsy();
    });
  });

  it("admits any number once maxToolInputElements is Infinity", async () => {
    await withServer({ maxToolInputElements: Infinity }, async (port) => {
      expect((await count(port, 20_000)).isError).toBeFalsy();
    });
  });

  // The SDK refuses such a value as it builds a server, which here happens on
  // every request; refused up front, it never gets that far.
  it.each([0, -1, Number.NaN])(
    "refuses a maxToolInputElements of %s when the server is created",
    (maxToolInputElements) => {
      expect(
        () =>
          new ViteMCP({
            maxToolInputElements,
            name: "Limits",
            version: "1.0.0",
          }),
      ).toThrow(RangeError);
    },
  );
});
