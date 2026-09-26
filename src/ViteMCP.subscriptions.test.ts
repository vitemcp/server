import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runWithTestServer } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

const STATUS_URI = "file:///status";

type Session = { role: string };

const admin = (auth: Session | undefined) => auth?.role === "admin";

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

  // `canAccess` keeps a resource out of `resources/read`; subscribing to its
  // URI must not reveal its updates instead.
  it("delivers only the updates the caller may read", async () => {
    const server = new ViteMCP<Session>({
      authenticate: async (request) => ({
        role: request.headers.get("authorization")?.includes("admin")
          ? "admin"
          : "user",
      }),
      name: "Test",
      version: "1.0.0",
    });

    server.addResource({
      canAccess: admin,
      load: async () => ({ text: "secret" }),
      name: "secret",
      uri: "file:///secret",
    });
    server.addResourceTemplate({
      arguments: [{ name: "id" }],
      canAccess: admin,
      load: async () => ({ text: "record" }),
      name: "record",
      uriTemplate: "file:///records/{id}",
    });
    server.addResource({
      load: async () => ({ text: "ok" }),
      name: "status",
      uri: STATUS_URI,
    });

    await server.start({
      httpStream: { port: 0 },
      transportType: "httpStream",
    });

    const listen = async (token: string, uris: string[]) => {
      const client = new Client(
        { name: token, version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      const updated: string[] = [];

      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${server.port}/mcp`),
          { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
        ),
      );

      client.setNotificationHandler(
        "notifications/resources/updated",
        ({ params }) => {
          updated.push(params.uri);
        },
      );

      return {
        client,
        subscription: await client.listen({ resourceSubscriptions: uris }),
        updated,
      };
    };

    const hidden = ["file:///secret", "file:///records/1"];
    const listeners = [
      await listen("user", [...hidden, STATUS_URI]),
      await listen("admin", hidden),
    ];
    const [user, adminListener] = listeners;

    try {
      for (const uri of [...hidden, STATUS_URI]) {
        server.notifyResourceUpdated(uri);
      }

      // A stream delivers in order: once the visible update has arrived, a
      // hidden one sent before it would have arrived too.
      await vi.waitFor(() => expect(user.updated).toContain(STATUS_URI));
      expect(user.updated).toEqual([STATUS_URI]);

      await vi.waitFor(() => expect(adminListener.updated).toEqual(hidden));
    } finally {
      for (const { client, subscription } of listeners) {
        await subscription.close();
        await client.close();
      }

      await server.stop();
    }
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
