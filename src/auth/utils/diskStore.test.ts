import { chmod, mkdir, readdir, rm, stat } from "fs/promises";
import { join } from "path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DiskStore } from "./diskStore.js";

/**
 * Counts and optionally parks directory walks so a cleanup sweep can be held
 * open deterministically. Everything else delegates to the real `fs/promises`,
 * so the rest of this file is unaffected.
 */
const readdirGate = vi.hoisted(() => ({
  blocked: null as null | Promise<void>,
  count: 0,
  onCall: null as (() => void) | null,
}));

/**
 * Codes the next renames fail with instead of reaching the real `fs/promises`,
 * as a Windows rename does while another handle has the entry open.
 */
const renameFailures = vi.hoisted(() => ({
  calls: 0,
  codes: [] as string[],
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();

  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      readdirGate.count += 1;
      readdirGate.onCall?.();

      if (readdirGate.blocked) {
        await readdirGate.blocked;
      }

      return actual.readdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameFailures.calls += 1;

      const code = renameFailures.codes.shift();

      if (code) {
        throw Object.assign(new Error(`${code}: rename`), { code });
      }

      return actual.rename(...args);
    },
  };
});

const TEST_DIR = join(process.cwd(), ".test-disk-store");

describe("DiskStore", () => {
  beforeAll(async () => {
    // Clean up any leftover test directory
    try {
      await rm(TEST_DIR, { force: true, recursive: true });
    } catch {
      // Ignore errors
    }
  });

  afterEach(() => {
    readdirGate.blocked = null;
    readdirGate.count = 0;
    readdirGate.onCall = null;
    renameFailures.calls = 0;
    renameFailures.codes = [];
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await rm(TEST_DIR, { force: true, recursive: true });
    } catch {
      // Ignore errors
    }
  });

  afterAll(async () => {
    // Final cleanup
    try {
      await rm(TEST_DIR, { force: true, recursive: true });
    } catch {
      // Ignore errors
    }
  });

  it("should create directory if it doesn't exist", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    // Save a value to trigger directory creation
    await store.save("test", "value");

    const files = await readdir(TEST_DIR);
    expect(files.length).toBe(1);

    store.destroy();
  });

  it("should save and retrieve values", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    await store.save("key1", { data: "value1" });
    await store.save("key2", "value2");

    const value1 = await store.get("key1");
    const value2 = await store.get("key2");

    expect(value1).toEqual({ data: "value1" });
    expect(value2).toBe("value2");

    store.destroy();
  });

  it("should return null for non-existent keys", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    const value = await store.get("nonexistent");

    expect(value).toBeNull();

    store.destroy();
  });

  it("should delete values", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    await store.save("key", "value");
    let value = await store.get("key");
    expect(value).toBe("value");

    await store.delete("key");
    value = await store.get("key");
    expect(value).toBeNull();

    store.destroy();
  });

  it("should handle TTL expiration", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    // Save with 1 second TTL
    await store.save("key", "value", 1);

    // Should exist immediately
    let value = await store.get("key");
    expect(value).toBe("value");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should be null after expiration
    value = await store.get("key");
    expect(value).toBeNull();

    store.destroy();
  });

  it("should clean up expired entries", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    // Save items with short TTL
    await store.save("key1", "value1", 1);
    await store.save("key2", "value2", 1);
    await store.save("key3", "value3", 3600); // 1 hour

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Run cleanup
    await store.cleanup();

    // Only key3 should remain
    const size = await store.size();
    expect(size).toBe(1);

    const value3 = await store.get("key3");
    expect(value3).toBe("value3");

    store.destroy();
  });

  it("should not start a second sweep while one is in flight", async () => {
    const store = new DiskStore({ directory: TEST_DIR });
    await store.save("key1", "value1", 3600);

    let release!: () => void;
    const sweepEntered = new Promise<void>((resolve) => {
      readdirGate.onCall = resolve;
    });
    readdirGate.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    readdirGate.count = 0;

    const first = store.cleanup();
    const second = store.cleanup();

    // The first sweep is now parked inside readdir. The second must have
    // joined it rather than walking the directory again.
    await sweepEntered;
    expect(readdirGate.count).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(readdirGate.count).toBe(1);

    // Once the guard clears, a later call sweeps again.
    readdirGate.blocked = null;
    readdirGate.onCall = null;
    await store.cleanup();
    expect(readdirGate.count).toBe(2);

    store.destroy();
  });

  it("should sanitize keys to prevent directory traversal", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    await store.save("../../../malicious", "value");
    const value = await store.get("../../../malicious");

    expect(value).toBe("value");

    // Verify file was created in the correct directory
    const files = await readdir(TEST_DIR);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^_________malicious\.json$/);

    store.destroy();
  });

  it("should handle concurrent operations", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    // Run multiple save operations concurrently
    await Promise.all([
      store.save("key1", "value1"),
      store.save("key2", "value2"),
      store.save("key3", "value3"),
      store.save("key4", "value4"),
      store.save("key5", "value5"),
    ]);

    // Verify all values
    const values = await Promise.all([
      store.get("key1"),
      store.get("key2"),
      store.get("key3"),
      store.get("key4"),
      store.get("key5"),
    ]);

    expect(values).toEqual(["value1", "value2", "value3", "value4", "value5"]);

    store.destroy();
  });

  // writeFile() truncates before it writes, so overwriting an entry in place
  // left a moment in which the file was empty or half-written.
  describe("overwriting an entry", () => {
    // Large enough that the write is not over before a reader gets in.
    const value = { blob: "x".repeat(100_000) };

    it("should never report the key as missing to a concurrent get()", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("key", value);

      const reads: unknown[] = [];

      for (let i = 0; i < 20; i++) {
        const [, read] = await Promise.all([
          store.save("key", value),
          store.get("key"),
        ]);
        reads.push(read);
      }

      expect(reads.filter((read) => read === null)).toHaveLength(0);

      store.destroy();
    });

    it("should not be deleted as corrupt by a concurrent cleanup()", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("key", value);

      for (let i = 0; i < 20; i++) {
        await Promise.all([store.save("key", value), store.cleanup()]);

        expect(await store.get("key")).toEqual(value);
      }

      store.destroy();
    });

    it("should not leave temporary files behind", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("key", "first");
      await store.save("key", "second");

      expect(await readdir(TEST_DIR)).toEqual(["key.json"]);

      store.destroy();
    });

    it("should remove the temporary file when the entry cannot be replaced", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      // A directory where the entry belongs, which rename() cannot replace.
      await mkdir(join(TEST_DIR, "key.json"), { recursive: true });

      await expect(store.save("key", "value")).rejects.toThrow();
      expect(await readdir(TEST_DIR)).toEqual(["key.json"]);

      error.mockRestore();
      store.destroy();
    });

    // Windows can refuse to replace a file another handle has open, so a get()
    // or cleanup() reading the entry at that instant failed the save outright.
    describe("when Windows refuses the rename for a moment", () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

      const runOn = (value: NodeJS.Platform) =>
        Object.defineProperty(process, "platform", { ...platform, value });

      afterEach(() => {
        Object.defineProperty(process, "platform", platform);
      });

      it.each(["EPERM", "EACCES", "EBUSY"])(
        "should replace the entry once %s passes",
        async (code) => {
          runOn("win32");
          const store = new DiskStore({ directory: TEST_DIR });
          await store.save("key", "first");

          renameFailures.calls = 0;
          renameFailures.codes = [code, code];
          await store.save("key", "second");

          expect(renameFailures.calls).toBe(3);
          expect(await store.get("key")).toBe("second");
          expect(await readdir(TEST_DIR)).toEqual(["key.json"]);

          store.destroy();
        },
      );

      it("should give up after five retries, leaving the entry in place", async () => {
        runOn("win32");
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const store = new DiskStore({ directory: TEST_DIR });
        await store.save("key", "first");

        renameFailures.calls = 0;
        renameFailures.codes = new Array<string>(6).fill("EPERM");

        await expect(store.save("key", "second")).rejects.toMatchObject({
          code: "EPERM",
        });
        expect(renameFailures.calls).toBe(6);
        expect(await store.get("key")).toBe("first");
        expect(await readdir(TEST_DIR)).toEqual(["key.json"]);

        error.mockRestore();
        store.destroy();
      });

      it("should not retry an error that will not pass", async () => {
        runOn("win32");
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const store = new DiskStore({ directory: TEST_DIR });

        renameFailures.codes = ["ENOSPC"];

        await expect(store.save("key", "value")).rejects.toMatchObject({
          code: "ENOSPC",
        });
        expect(renameFailures.calls).toBe(1);
        expect(await readdir(TEST_DIR)).toEqual([]);

        error.mockRestore();
        store.destroy();
      });

      it("should not retry on another platform", async () => {
        runOn("linux");
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const store = new DiskStore({ directory: TEST_DIR });

        renameFailures.codes = ["EPERM"];

        await expect(store.save("key", "value")).rejects.toMatchObject({
          code: "EPERM",
        });
        expect(renameFailures.calls).toBe(1);

        error.mockRestore();
        store.destroy();
      });
    });
  });

  it("should count stored items", async () => {
    const store = new DiskStore({ directory: TEST_DIR });

    expect(await store.size()).toBe(0);

    await store.save("key1", "value1");
    expect(await store.size()).toBe(1);

    await store.save("key2", "value2");
    expect(await store.size()).toBe(2);

    await store.delete("key1");
    expect(await store.size()).toBe(1);

    store.destroy();
  });

  it("should use custom file extension", async () => {
    const store = new DiskStore({
      directory: TEST_DIR,
      fileExtension: ".dat",
    });

    await store.save("key", "value");

    const files = await readdir(TEST_DIR);
    expect(files[0]).toMatch(/\.dat$/);

    store.destroy();
  });

  describe("take", () => {
    it("should return the value and remove it", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("take-key", { token: "secret" });

      expect(await store.take("take-key")).toEqual({ token: "secret" });
      expect(await store.get("take-key")).toBeNull();

      store.destroy();
    });

    it("should return null for a missing key", async () => {
      const store = new DiskStore({ directory: TEST_DIR });

      expect(await store.take("no-such-key")).toBeNull();

      store.destroy();
    });

    it("should hand the value to exactly one of several concurrent callers", async () => {
      // The rename() claim is what makes single-use safe when several
      // processes share the directory.
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("contended-key", "value");

      const results = await Promise.all([
        store.take("contended-key"),
        store.take("contended-key"),
        store.take("contended-key"),
      ]);

      expect(results.filter((result) => result !== null)).toEqual(["value"]);

      store.destroy();
    });

    it("should not leave claim files behind", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      await store.save("claim-key", "value");
      await store.take("claim-key");

      const files = await readdir(TEST_DIR);
      expect(files.filter((file) => file.includes(".claim"))).toHaveLength(0);

      store.destroy();
    });
  });

  // Windows has no POSIX mode bits, so `mode` is ignored there.
  describe.skipIf(process.platform === "win32")("file permissions", () => {
    it("should keep stored credentials unreadable by group and other", async () => {
      const store = new DiskStore({ directory: TEST_DIR });

      // The key becomes the filename, so a listable directory leaks the
      // authorization code even to someone who cannot read the file.
      await store.save("code:an-authorization-code", {
        accessToken: "AT",
        refreshToken: "RT",
      });

      const [directoryMode, fileMode] = await Promise.all([
        stat(TEST_DIR).then((stats) => stats.mode),
        stat(join(TEST_DIR, "code_an-authorization-code.json")).then(
          (stats) => stats.mode,
        ),
      ]);

      expect(directoryMode & 0o077).toBe(0);
      expect(fileMode & 0o077).toBe(0);

      store.destroy();
    });

    it("should tighten an entry left with a looser mode when it is next written", async () => {
      const store = new DiskStore({ directory: TEST_DIR });
      const file = join(TEST_DIR, "token-key.json");

      // As an entry written by an earlier version would have been.
      await store.save("token-key", { accessToken: "AT-old" });
      await chmod(file, 0o644);

      await store.save("token-key", { accessToken: "AT-new" });

      expect((await stat(file)).mode & 0o077).toBe(0);

      store.destroy();
    });
  });
});
