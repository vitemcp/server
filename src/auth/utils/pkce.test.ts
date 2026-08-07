/**
 * PKCE Utilities Tests
 */

import { describe, expect, it } from "vitest";

import { PKCEUtils } from "./pkce.js";

describe("PKCEUtils", () => {
  describe("generateVerifier", () => {
    it("should generate a verifier of default length", () => {
      const verifier = PKCEUtils.generateVerifier();
      expect(verifier).toBeDefined();
      expect(verifier.length).toBe(128);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should generate a verifier of specified length", () => {
      const verifier = PKCEUtils.generateVerifier(64);
      expect(verifier.length).toBe(64);
    });

    it("should generate different verifiers each time", () => {
      const verifier1 = PKCEUtils.generateVerifier();
      const verifier2 = PKCEUtils.generateVerifier();
      expect(verifier1).not.toBe(verifier2);
    });

    it("should throw error for invalid length", () => {
      expect(() => PKCEUtils.generateVerifier(42)).toThrow();
      expect(() => PKCEUtils.generateVerifier(129)).toThrow();
    });
  });

  describe("generateChallenge", () => {
    it("should generate S256 challenge from verifier", () => {
      const verifier = "test-verifier-12345";
      const challenge = PKCEUtils.generateChallenge(verifier, "S256");

      expect(challenge).toBeDefined();
      expect(challenge).not.toBe(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should generate plain challenge from verifier", () => {
      const verifier = "test-verifier-12345";
      const challenge = PKCEUtils.generateChallenge(verifier, "plain");

      expect(challenge).toBe(verifier);
    });

    it("should generate same challenge for same verifier", () => {
      const verifier = PKCEUtils.generateVerifier();
      const challenge1 = PKCEUtils.generateChallenge(verifier, "S256");
      const challenge2 = PKCEUtils.generateChallenge(verifier, "S256");

      expect(challenge1).toBe(challenge2);
    });
  });

  describe("validateChallenge", () => {
    it("should validate S256 challenge correctly", () => {
      const verifier = PKCEUtils.generateVerifier();
      const challenge = PKCEUtils.generateChallenge(verifier, "S256");

      const valid = PKCEUtils.validateChallenge(verifier, challenge, "S256");
      expect(valid).toBe(true);
    });

    it("should validate plain challenge correctly", () => {
      const verifier = "test-verifier";
      const challenge = PKCEUtils.generateChallenge(verifier, "plain");

      const valid = PKCEUtils.validateChallenge(verifier, challenge, "plain");
      expect(valid).toBe(true);
    });

    it("should reject invalid verifier", () => {
      const verifier = PKCEUtils.generateVerifier();
      const challenge = PKCEUtils.generateChallenge(verifier, "S256");
      const wrongVerifier = PKCEUtils.generateVerifier();

      const valid = PKCEUtils.validateChallenge(
        wrongVerifier,
        challenge,
        "S256",
      );
      expect(valid).toBe(false);
    });

    it("should reject empty verifier or challenge", () => {
      expect(PKCEUtils.validateChallenge("", "challenge", "S256")).toBe(false);
      expect(PKCEUtils.validateChallenge("verifier", "", "S256")).toBe(false);
    });

    // Regression tests for CWE-208 (observable timing discrepancy). Both
    // branches compare with crypto.timingSafeEqual behind a length guard, like
    // the cookie signature in consent.ts and the JWT signature in jwtIssuer.ts;
    // these lock that behaviour in.
    it("should reject a same-length wrong verifier in the plain branch", () => {
      const verifier = PKCEUtils.generateVerifier();
      // Flip one character while preserving length so the comparison reaches
      // timingSafeEqual, not just the length pre-check.
      const forged = (verifier[0] === "a" ? "b" : "a") + verifier.slice(1);
      expect(forged).toHaveLength(verifier.length);
      expect(forged).not.toBe(verifier);

      expect(PKCEUtils.validateChallenge(forged, verifier, "plain")).toBe(
        false,
      );
      expect(PKCEUtils.validateChallenge(verifier, verifier, "plain")).toBe(
        true,
      );
    });

    it("should reject a longer verifier without throwing", () => {
      const verifier = PKCEUtils.generateVerifier();

      // The length guard must reject this rather than letting timingSafeEqual
      // throw, which would turn an invalid_grant into a 500 at /oauth/token.
      expect(() =>
        PKCEUtils.validateChallenge(`${verifier}extra`, verifier, "plain"),
      ).not.toThrow();
      expect(
        PKCEUtils.validateChallenge(`${verifier}extra`, verifier, "plain"),
      ).toBe(false);
    });

    it("should reject a same-length wrong challenge in the S256 branch", () => {
      const verifier = PKCEUtils.generateVerifier();
      const challenge = PKCEUtils.generateChallenge(verifier, "S256");
      const forged = (challenge[0] === "a" ? "b" : "a") + challenge.slice(1);
      expect(forged).toHaveLength(challenge.length);
      expect(forged).not.toBe(challenge);

      expect(PKCEUtils.validateChallenge(verifier, forged, "S256")).toBe(false);
      expect(PKCEUtils.validateChallenge(verifier, challenge, "S256")).toBe(
        true,
      );
    });
  });

  describe("generatePair", () => {
    it("should generate valid PKCE pair with S256", () => {
      const pair = PKCEUtils.generatePair("S256");

      expect(pair.verifier).toBeDefined();
      expect(pair.challenge).toBeDefined();
      expect(pair.verifier.length).toBe(128);

      const valid = PKCEUtils.validateChallenge(
        pair.verifier,
        pair.challenge,
        "S256",
      );
      expect(valid).toBe(true);
    });

    it("should generate valid PKCE pair with plain", () => {
      const pair = PKCEUtils.generatePair("plain");

      expect(pair.verifier).toBe(pair.challenge);
    });
  });
});
