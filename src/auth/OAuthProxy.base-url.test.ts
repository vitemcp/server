/**
 * A `baseUrl` written with a trailing slash.
 *
 * Every address the proxy names is `baseUrl` with a path appended, so
 * `https://proxy.example.com/` came out as
 * `https://proxy.example.com//oauth/token`: advertised in the metadata and
 * answered by no route, and — as the redirect URI sent upstream — not the
 * callback that was registered with the provider.
 */
import { afterEach, describe, expect, it } from "vitest";

import { OAuthProxy } from "./OAuthProxy.js";

const config = {
  allowedRedirectUriPatterns: ["https://client.example.com/*"],
  consentRequired: false,
  encryptionKey: false as const,
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: "upstream-client-id",
  upstreamClientSecret: "upstream-client-secret",
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
};

const REDIRECT_URI = "https://client.example.com/callback";

describe("OAuthProxy baseUrl with a trailing slash", () => {
  const proxies: OAuthProxy[] = [];

  const proxyAt = (baseUrl: string) => {
    const proxy = new OAuthProxy({ ...config, baseUrl });
    proxies.push(proxy);
    return proxy;
  };

  afterEach(() => {
    for (const proxy of proxies.splice(0)) {
      proxy.destroy();
    }
  });

  it("advertises the endpoints it would without one", () => {
    expect(
      proxyAt("https://proxy.example.com/").getAuthorizationServerMetadata(),
    ).toEqual(
      proxyAt("https://proxy.example.com").getAuthorizationServerMetadata(),
    );
  });

  it("keeps a path the base URL is mounted under", () => {
    expect(
      proxyAt(
        "https://proxy.example.com/issuer1/",
      ).getAuthorizationServerMetadata(),
    ).toMatchObject({
      issuer: "https://proxy.example.com/issuer1",
      tokenEndpoint: "https://proxy.example.com/issuer1/oauth/token",
    });
  });

  it("sends the provider the callback that was registered with it", async () => {
    const proxy = proxyAt("https://proxy.example.com/");
    const client = await proxy.registerClient({
      redirect_uris: [REDIRECT_URI],
    });

    const response = await proxy.authorize({
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      state: "client-state",
    });

    expect(
      new URL(response.headers.get("location")!).searchParams.get(
        "redirect_uri",
      ),
    ).toBe("https://proxy.example.com/oauth/callback");
  });
});
