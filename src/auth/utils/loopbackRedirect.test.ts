import { describe, expect, it } from "vitest";

import { loopbackRedirectMatches } from "./loopbackRedirect.js";

const PORTLESS = "http://localhost/callback";

describe("loopbackRedirectMatches", () => {
  it("accepts an identical URI", () => {
    expect(loopbackRedirectMatches(PORTLESS, PORTLESS)).toBe(true);
  });

  describe("RFC 8252 §7.3 - a portless loopback declaration matches any port", () => {
    it.each([
      "http://localhost:1/callback",
      "http://localhost:3118/callback",
      "http://localhost:52430/callback",
      "http://localhost:65535/callback",
    ])("accepts %s", (requested) => {
      expect(loopbackRedirectMatches(PORTLESS, requested)).toBe(true);
    });

    it("accepts an ephemeral port on 127.0.0.1", () => {
      expect(
        loopbackRedirectMatches(
          "http://127.0.0.1/callback",
          "http://127.0.0.1:52430/callback",
        ),
      ).toBe(true);
    });

    it("accepts an ephemeral port on IPv6 loopback", () => {
      expect(
        loopbackRedirectMatches(
          "http://[::1]/callback",
          "http://[::1]:52430/callback",
        ),
      ).toBe(true);
    });
  });

  describe("only the port is relaxed", () => {
    it.each([
      ["a scheme change", "https://localhost:52430/callback"],
      ["userinfo", "http://user:pw@localhost:52430/callback"],
      ["a different host", "http://evil.test:52430/callback"],
      ["a host that merely contains the name", "http://localhost.evil.test:52430/callback"],
      ["a different loopback host", "http://127.0.0.1:52430/callback"],
      ["a deeper path", "http://localhost:52430/callback/extra"],
      ["a sibling path prefix", "http://localhost:52430/callbackevil"],
      ["a query string", "http://localhost:52430/callback?next=evil"],
      ["a fragment", "http://localhost:52430/callback#evil"],
      ["a trailing slash", "http://localhost:52430/callback/"],
      ["malformed input", "not a url"],
    ])("rejects %s", (_label, requested) => {
      expect(loopbackRedirectMatches(PORTLESS, requested)).toBe(false);
    });

    it("rejects userinfo on the declared side", () => {
      expect(
        loopbackRedirectMatches(
          "http://user:pw@localhost/callback",
          "http://localhost:52430/callback",
        ),
      ).toBe(false);
    });
  });

  describe("a declaration that names a port means that port", () => {
    it("rejects a different port", () => {
      expect(
        loopbackRedirectMatches(
          "http://localhost:1455/callback",
          "http://localhost:52430/callback",
        ),
      ).toBe(false);
    });

    it("accepts the same port", () => {
      expect(
        loopbackRedirectMatches(
          "http://localhost:1455/callback",
          "http://localhost:1455/callback",
        ),
      ).toBe(true);
    });
  });

  describe("non-loopback hosts keep exact port semantics", () => {
    it("rejects an added port on a public host", () => {
      expect(
        loopbackRedirectMatches(
          "https://client.example.com/callback",
          "https://client.example.com:8443/callback",
        ),
      ).toBe(false);
    });
  });
});
