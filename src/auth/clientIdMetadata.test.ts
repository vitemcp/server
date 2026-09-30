import { describe, expect, it } from "vitest";

import {
  ClientIdMetadataError,
  ClientIdMetadataResolver,
  isBlockedAddress,
  isClientIdMetadataUrl,
  validateClientIdMetadata,
} from "./clientIdMetadata.js";

/**
 * Resolving a URL-formatted `client_id` means fetching a URL an unauthenticated
 * caller chose. These tests exist to prove the fetch cannot be turned into a
 * probe of the host's own network.
 */
describe("Client ID Metadata Documents", () => {
  describe("client_id shape", () => {
    it("accepts an https URL with a path", () => {
      expect(isClientIdMetadataUrl("https://app.example.com/client.json")).toBe(
        true,
      );
    });

    it("rejects http, a bare origin, and opaque ids", () => {
      // http would let a network attacker swap the document wholesale; a bare
      // origin is not a metadata document and widens the fetch surface.
      expect(isClientIdMetadataUrl("http://app.example.com/client.json")).toBe(
        false,
      );
      expect(isClientIdMetadataUrl("https://app.example.com")).toBe(false);
      expect(isClientIdMetadataUrl("https://app.example.com/")).toBe(false);
      expect(isClientIdMetadataUrl("a1b2c3d4")).toBe(false);
    });
  });

  describe("SSRF defences", () => {
    it("refuses a host that resolves to loopback", async () => {
      const resolver = new ClientIdMetadataResolver();

      // localhost resolves to 127.0.0.1 / ::1. The refusal happens inside the
      // connection's own DNS lookup, so it also covers a name that only points
      // inward at connect time (DNS rebinding).
      await expect(
        resolver.resolve("https://localhost/client.json"),
      ).rejects.toBeInstanceOf(ClientIdMetadataError);
    });

    it("refuses the cloud instance-metadata address", async () => {
      const resolver = new ClientIdMetadataResolver();

      // 169.254.169.254 is the highest-value SSRF target in a hosted
      // deployment: it serves instance credentials.
      await expect(
        resolver.resolve("https://169.254.169.254/latest/meta-data/"),
      ).rejects.toBeInstanceOf(ClientIdMetadataError);
    });

    it("refuses private address literals", async () => {
      const resolver = new ClientIdMetadataResolver();

      for (const host of [
        "10.0.0.1",
        "192.168.1.1",
        "172.16.0.1",
        "127.0.0.1",
      ]) {
        await expect(
          resolver.resolve(`https://${host}/client.json`),
        ).rejects.toBeInstanceOf(ClientIdMetadataError);
      }
    });

    // A literal never reaches the DNS hook, so the address check is all that
    // stands between the fetch and the host's own network. `URL` writes an
    // embedded IPv4 address in hex — `[::ffff:127.0.0.1]` arrives as
    // `[::ffff:7f00:1]` — and matched only in its dotted form it was taken
    // for a public IPv6 address: the request went to loopback.
    it("refuses an IPv4 address carried inside an IPv6 literal", async () => {
      const resolver = new ClientIdMetadataResolver();

      for (const host of [
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:169.254.169.254]",
        "[::ffff:10.0.0.1]",
        "[::127.0.0.1]",
        "[64:ff9b::10.0.0.1]",
      ]) {
        // The message, not only the class: a fetch that was attempted and
        // failed is a `ClientIdMetadataError` too.
        await expect(
          resolver.resolve(`https://${host}/client.json`),
        ).rejects.toThrow(/internal address/);
      }
    });

    it("judges an address by the network it reaches, however it is written", () => {
      const internal: [string, number][] = [
        ["127.0.0.1", 4],
        ["169.254.169.254", 4],
        ["::", 6],
        ["::1", 6],
        ["0:0:0:0:0:0:0:1", 6],
        ["fe80::1%lo0", 6],
        ["fd00:ec2::254", 6],
        ["ff02::1", 6],
        // IPv4-mapped, dotted and as `URL` normalises it.
        ["::ffff:127.0.0.1", 6],
        ["::ffff:7f00:1", 6],
        ["::ffff:a9fe:a9fe", 6],
        ["::ffff:192.168.1.1", 6],
        // IPv4-compatible, and the NAT64 prefix a gateway translates.
        ["::10.0.0.1", 6],
        ["64:ff9b::a00:1", 6],
        // Not an address: refused rather than guessed at.
        ["not-an-address", 6],
      ];
      const external: [string, number][] = [
        ["8.8.8.8", 4],
        ["2606:4700:4700::1111", 6],
        ["2001:4860:4860::8888", 6],
        // Carrying a public IPv4 address is not a reason to refuse.
        ["::ffff:8.8.8.8", 6],
        ["::ffff:808:808", 6],
        ["64:ff9b::808:808", 6],
      ];

      for (const [address, family] of internal) {
        expect(isBlockedAddress(address, family), address).toBe(true);
      }

      for (const [address, family] of external) {
        expect(isBlockedAddress(address, family), address).toBe(false);
      }
    });

    it("honours a domain trust policy", async () => {
      const resolver = new ClientIdMetadataResolver({
        allowedDomains: ["trusted.example.com"],
      });

      await expect(
        resolver.resolve("https://evil.example.com/client.json"),
      ).rejects.toThrow(/not allowed/);
    });

    it("can be disabled entirely", async () => {
      const resolver = new ClientIdMetadataResolver({ enabled: false });

      expect(resolver.enabled).toBe(false);
      await expect(
        resolver.resolve("https://app.example.com/client.json"),
      ).rejects.toThrow(/not enabled/);
    });
  });

  describe("document validation", () => {
    const URL_ID = "https://app.example.com/client.json";

    const doc = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        client_id: URL_ID,
        client_name: "Example Client",
        redirect_uris: ["http://127.0.0.1:3000/callback"],
        ...overrides,
      });

    it("accepts a well-formed document", () => {
      const metadata = validateClientIdMetadata(doc(), URL_ID);

      expect(metadata.client_name).toBe("Example Client");
      expect(metadata.redirect_uris).toEqual([
        "http://127.0.0.1:3000/callback",
      ]);
    });

    it("rejects a document whose client_id does not match its URL", () => {
      // Without this check, anyone could host a document claiming to be
      // someone else's client and inherit their consent.
      expect(() =>
        validateClientIdMetadata(
          doc({ client_id: "https://someone-else.example.com/client.json" }),
          URL_ID,
        ),
      ).toThrow(/does not match/);
    });

    it("rejects malformed or incomplete documents", () => {
      expect(() => validateClientIdMetadata("not json", URL_ID)).toThrow(
        /not valid JSON/,
      );
      expect(() => validateClientIdMetadata("[]", URL_ID)).toThrow(
        /must be a JSON object/,
      );
      expect(() =>
        validateClientIdMetadata(doc({ client_name: undefined }), URL_ID),
      ).toThrow(/client_name/);
      expect(() =>
        validateClientIdMetadata(doc({ redirect_uris: [] }), URL_ID),
      ).toThrow(/redirect_uris/);
      expect(() =>
        validateClientIdMetadata(doc({ redirect_uris: [42] }), URL_ID),
      ).toThrow(/redirect_uris/);
    });
  });
});
