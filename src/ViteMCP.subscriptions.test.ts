import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

const STATUS_URI = "file:///status";

const withResource = () => {
  const server = new ViteMCP({ name: "Test", version: "1.0.0" });

  server.addResource({
    load: async () => ({ text: "ok" }),
    mimeType: "text/plain",
    name: "status",
    uri: STATUS_URI,
  });

  return server;
};

describe("resource subscriptions", () => {
  // The SDK dropped `resourceSubscriptions` from the listen filter for want of
  // `resources.subscribe`, so `notifyResourceUpdated` reached no one.
  it("delivers an update to a stream subscribed to the URI", async () => {
    await runWithTestServer({
      run: async ({ client, server }) => {
        const updated: string[] = [];

        client.setNotificationHandler(
          "notifications/resources/updated",
          ({ params }) => {
            updated.push(params.uri);
          },
        );

        const subscription = await client.listen({
          resourceSubscriptions: [STATUS_URI],
        });

        try {
          expect(subscription.honoredFilter).toEqual({
            resourceSubscriptions: [STATUS_URI],
          });

          server.notifyResourceUpdated(STATUS_URI);

          await vi.waitFor(() => expect(updated).toEqual([STATUS_URI]));
        } finally {
          await subscription.close();
        }
      },
      server: withResource,
    });
  });

  it("offers them to a 2026-07-28 client", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(client.getServerCapabilities()?.resources).toEqual({
          listChanged: true,
          subscribe: true,
        });
      },
      server: withResource,
    });
  });

  it("does not offer them to a 2025-era client, which has no way to subscribe", async () => {
    await runWithTestServer({
      client: async () =>
        new Client({ name: "legacy-client", version: "1.0.0" }),
      run: async ({ client }) => {
        expect(client.getServerCapabilities()?.resources).toEqual({
          listChanged: true,
        });
      },
      server: withResource,
    });
  });

  it("does not advertise resources for a server that has none", async () => {
    await runWithTestServer({
      run: async ({ client }) => {
        expect(client.getServerCapabilities()?.resources).toBeUndefined();
      },
      server: () => {
        const server = new ViteMCP({ name: "Test", version: "1.0.0" });

        server.addTool({
          execute: async () => "ok",
          name: "noop",
          parameters: z.object({}),
        });

        return server;
      },
    });
  });
});
