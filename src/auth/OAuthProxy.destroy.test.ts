/**
 * `destroy()` is the only teardown the proxy exposes, so it has to release
 * everything the proxy allocated, including the fallback storage's interval
 * once the storage is wrapped in `EncryptedTokenStorage` (no `destroy()`),
 * which leaves it reachable from nowhere else.
 *
 * None of the cleanup timers keeps the event loop alive, so a process that has
 * stopped serving exits without `destroy()` and
 * `process.getActiveResourcesInfo()` no longer lists them. They are counted
 * through fake timers instead, which see every interval that is scheduled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViteMCP } from "../ViteMCP.js";
import { OAuthProxy } from "./OAuthProxy.js";
import { MemoryTokenStorage } from "./utils/tokenStore.js";

const baseConfig = {
  baseUrl: "https://proxy.example.com",
  upstreamAuthorizationEndpoint: "https://provider.com/oauth/authorize",
  upstreamClientId: "upstream-client-id",
  upstreamClientSecret: "upstream-client-secret",
  upstreamTokenEndpoint: "https://provider.com/oauth/token",
};

/** How many intervals are scheduled, whether or not they keep Node alive. */
const activeTimers = () => vi.getTimerCount();

describe("OAuthProxy cleanup timers", () => {
  // A proxy is not the server's to destroy, and `stop()` leaves it running, so
  // a timer that held the process open would do so until `destroy()`: a script
  // that stopped its server never exited. Real timers here, since this is the
  // state Node itself reports.
  it("do not keep the process alive", () => {
    const tokenStorage = new MemoryTokenStorage();
    const owning = new OAuthProxy(baseConfig);
    const lending = new OAuthProxy({ ...baseConfig, tokenStorage });

    try {
      // The proxy's own sweep, whichever storage it was given.
      expect(owning["cleanupInterval"]?.hasRef()).toBe(false);
      expect(lending["cleanupInterval"]?.hasRef()).toBe(false);

      // The storage's sweep: the one the proxy created for itself, which only
      // the proxy can reach, and the one it was handed.
      expect(owning["ownedTokenStorage"]?.["cleanupInterval"]?.hasRef()).toBe(
        false,
      );
      expect(tokenStorage["cleanupInterval"]?.hasRef()).toBe(false);
    } finally {
      owning.destroy();
      lending.destroy();
      tokenStorage.destroy();
    }
  });
});

describe("OAuthProxy destroy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["clearInterval", "Date", "setInterval"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("releases the timers of the token storage it created for itself", () => {
    const before = activeTimers();

    const proxy = new OAuthProxy(baseConfig);

    // Sanity check, so the assertion below cannot pass vacuously: two timers
    // start here, the proxy's own cleanup sweep and the fallback storage's.
    expect(activeTimers()).toBe(before + 2);

    proxy.destroy();

    // Before the fix the storage timer survived and this came back one over
    // the baseline.
    expect(activeTimers()).toBe(before);
  });

  it("leaves a caller-supplied storage running", async () => {
    const before = activeTimers();

    const tokenStorage = new MemoryTokenStorage();
    const withCallerStorage = activeTimers();

    // Written before the proxy exists, so it is an entry the proxy has no
    // business touching. MemoryTokenStorage.destroy() clears the map as well as
    // the timer, so a proxy that wrongly tore this storage down would lose it —
    // writing *after* destroy() would prove nothing, since a destroyed store
    // still accepts writes.
    await tokenStorage.save("caller-owned", "value");

    const proxy = new OAuthProxy({ ...baseConfig, tokenStorage });
    proxy.destroy();

    // The proxy tears down what it created, not what it was handed: the caller
    // may share one storage between proxies, or keep using it afterwards.
    expect(activeTimers()).toBe(withCallerStorage);
    expect(await tokenStorage.get("caller-owned")).toBe("value");

    tokenStorage.destroy();
    expect(activeTimers()).toBe(before);
  });

  it("can be called twice", () => {
    const before = activeTimers();

    const proxy = new OAuthProxy(baseConfig);
    proxy.destroy();
    proxy.destroy();

    expect(activeTimers()).toBe(before);
  });

  // `stop()` leaves the proxy and its storage running, since a stopped server
  // can start again, and it is the server holding the socket that keeps the
  // process up while it serves. A timer the process may exit without must still
  // run for as long as it does not.
  it("keeps cleaning up across a server restart", async () => {
    const tokenStorage = new MemoryTokenStorage();
    const cleanup = vi.spyOn(tokenStorage, "cleanup");
    const proxy = new OAuthProxy({ ...baseConfig, tokenStorage });
    const server = new ViteMCP({
      name: "oauth-test",
      oauth: { enabled: true, proxy },
      version: "1.0.0",
    });
    const options = {
      httpStream: { host: "127.0.0.1", port: 0 },
      transportType: "httpStream",
    } as const;

    try {
      await server.start(options);
      await server.stop();
      await server.start(options);

      await tokenStorage.save("expired", "value", 1);
      await vi.advanceTimersByTimeAsync(60_000);

      // The proxy's sweep and the storage's own, each once.
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(tokenStorage.size()).toBe(0);
    } finally {
      await server.stop();
      proxy.destroy();
      tokenStorage.destroy();
    }
  });
});
