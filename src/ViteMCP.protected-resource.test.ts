/**
 * RFC 9728 §3.3: a protected-resource document must name the resource whose
 * URL its well-known path was derived from, and a client discards one that
 * does not. With an `auth` provider that resource is the MCP endpoint, not the
 * provider's base URL, which is what the document named before.
 */
import { describe, expect, it } from "vitest";

import { OAuthProvider } from "./auth/providers/OAuthProvider.js";
import { allocateTestPort } from "./testHarness.js";
import { ViteMCP } from "./ViteMCP.js";

const provider = (baseUrl: string) =>
  new OAuthProvider({
    allowedRedirectUriPatterns: ["https://client.example.com/*"],
    authorizationEndpoint: "https://auth.example.com/authorize",
    baseUrl,
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenEndpoint: "https://auth.example.com/token",
  });

const resourceAt = async (url: string) =>
  ((await (await fetch(url)).json()) as { resource?: string }).resource;

describe("protected resource metadata from an auth provider", () => {
  it("names the endpoint a client following the 401 challenge asked for", async () => {
    const port = await allocateTestPort();
    const origin = `http://localhost:${port}`;
    const auth = provider(origin);
    const server = new ViteMCP({ auth, name: "Test", version: "1.0.0" });

    await server.start({ httpStream: { port }, transportType: "httpStream" });

    try {
      const challenge = await fetch(`${origin}/mcp`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(challenge.status).toBe(401);

      const metadataUrl = /resource_metadata="([^"]+)"/.exec(
        challenge.headers.get("WWW-Authenticate") ?? "",
      )?.[1];

      expect(metadataUrl).toBe(
        `${origin}/.well-known/oauth-protected-resource/mcp`,
      );
      expect(await resourceAt(metadataUrl!)).toBe(`${origin}/mcp`);

      // The root fallback serves the same document.
      expect(
        await resourceAt(`${origin}/.well-known/oauth-protected-resource`),
      ).toBe(`${origin}/mcp`);
    } finally {
      await server.stop();
      auth.destroy();
    }
  });

  it("names a custom endpoint under a base path", async () => {
    const port = await allocateTestPort();
    const origin = `http://localhost:${port}`;
    // The base URL carries the base path, as it must for the proxy's own
    // endpoints to resolve.
    const auth = provider(`${origin}/issuer1`);
    const server = new ViteMCP({ auth, name: "Test", version: "1.0.0" });

    await server.start({
      httpStream: { basePath: "/issuer1", endpoint: "/api/mcp", port },
      transportType: "httpStream",
    });

    try {
      expect(
        await resourceAt(
          `${origin}/.well-known/oauth-protected-resource/issuer1/api/mcp`,
        ),
      ).toBe(`${origin}/issuer1/api/mcp`);
    } finally {
      await server.stop();
      auth.destroy();
    }
  });
});
