/**
 * Disk-based Token Storage Implementation
 * Provides persistent file-based storage for OAuth tokens and transaction state
 */

import { createHash, randomUUID } from "crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "path";
import { setTimeout as delay } from "timers/promises";

import type { TokenStorage } from "../types.js";

export interface DiskStoreOptions {
  /**
   * How often to run cleanup (in milliseconds)
   * @default 60000 (1 minute)
   */
  cleanupIntervalMs?: number;

  /**
   * Directory path for storing data
   */
  directory: string;

  /**
   * File extension for stored files
   * @default ".json"
   */
  fileExtension?: string;
}

/** The file name length limit of common filesystems. */
const MAX_FILE_NAME_BYTES = 255;

interface StorageEntry {
  expiresAt: number;
  value: unknown;
}

/**
 * Disk-based token storage with TTL support
 * Persists tokens to filesystem for survival across server restarts
 */
export class DiskStore implements TokenStorage {
  private cleanupInFlight: null | Promise<void> = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private directory: string;
  private fileExtension: string;

  constructor(options: DiskStoreOptions) {
    this.directory = options.directory;
    this.fileExtension = options.fileExtension || ".json";

    // Ensure directory exists
    void this.ensureDirectory();

    // Start periodic cleanup
    const cleanupIntervalMs = options.cleanupIntervalMs || 60000;
    this.cleanupInterval = setInterval(() => {
      void this.cleanup();
    }, cleanupIntervalMs);
    // Housekeeping only: it must not keep a process alive that has nothing else
    // to do.
    this.cleanupInterval.unref?.();
  }

  /**
   * Clean up expired entries.
   *
   * A sweep walks the whole directory and reads every entry, so on a large
   * store it can outlast the cleanup interval. Callers arriving while one is
   * running — the timer below, the OAuth proxy's own cleanup timer, or a
   * direct call — join the sweep in flight instead of starting a second walk
   * over the same files, which would only make a slow sweep slower.
   */
  async cleanup(): Promise<void> {
    this.cleanupInFlight ??= this.runCleanup().finally(() => {
      this.cleanupInFlight = null;
    });

    return this.cleanupInFlight;
  }

  /**
   * Delete a value
   */
  async delete(key: string): Promise<void> {
    for (const filePath of this.getFilePaths(key)) {
      try {
        await rm(filePath);
      } catch (error) {
        // File might not exist, which is fine
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Failed to delete key ${key}:`, error);
        }
      }
    }
  }

  /**
   * Destroy the storage and clear cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Retrieve a value
   */
  async get(key: string): Promise<null | unknown> {
    for (const filePath of this.getFilePaths(key)) {
      try {
        const content = await readFile(filePath, "utf-8");
        const entry: StorageEntry = JSON.parse(content);

        // Check if expired. `force`, so that a concurrent cleanup() removing
        // it first does not read as "not here" and fall through to a stale
        // entry under the legacy name.
        if (entry.expiresAt < Date.now()) {
          await rm(filePath, { force: true });
          return null;
        }

        return entry.value;
      } catch (error) {
        // Not stored under this name: try the next one
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        // File is corrupted
        console.error(`Failed to read key ${key}:`, error);
        return null;
      }
    }

    return null;
  }

  /**
   * Save a value with optional TTL
   */
  async save(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.ensureDirectory();

    const filePath = this.getFilePath(key);
    const expiresAt = ttl ? Date.now() + ttl * 1000 : Number.MAX_SAFE_INTEGER;

    const entry: StorageEntry = {
      expiresAt,
      value,
    };

    // Written beside the entry and renamed over it, because writeFile()
    // truncates before it writes: a get() landing in between read an empty
    // file and reported the key missing, and a cleanup() sweep deleted it as
    // corrupt. rename() is atomic on POSIX filesystems, so a reader sees the
    // old entry or the new one. The temporary name does not end in the
    // extension, so cleanup() and size() pass over it.
    const tempPath = `${filePath}.${randomUUID()}.tmp`;

    try {
      // 0o600: entries hold authorization codes, access and refresh tokens and
      // PKCE verifiers, so nothing outside the owning user should read them.
      // Node only applies `mode` when it creates the file, and every save
      // creates one, so an entry carried over from an earlier version with a
      // looser mode is tightened the next time it is written.
      await writeFile(tempPath, JSON.stringify(entry, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await renameIntoPlace(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      console.error(`Failed to save key ${key}:`, error);
      throw error;
    }

    // An entry an earlier version wrote, named after the key, would otherwise
    // come back once this one is taken or deleted — a spent single-use code
    // among them. Never another key's current entry: no earlier version put a
    // `.` before the extension, and every current name has one.
    const legacyPath = this.getLegacyFilePath(key);

    if (legacyPath !== undefined) {
      await rm(legacyPath, { force: true });
    }
  }

  /**
   * Get the number of stored items
   */
  async size(): Promise<number> {
    try {
      await this.ensureDirectory();
      const files = await readdir(this.directory);
      return files.filter((f) => f.endsWith(this.fileExtension)).length;
    } catch {
      return 0;
    }
  }

  /**
   * Atomically retrieve a value and delete it.
   *
   * rename() is atomic on POSIX filesystems, so when several processes race
   * for the same key exactly one rename succeeds and the losers see ENOENT.
   * That is what makes single-use authorization codes safe when more than one
   * process shares the directory.
   */
  async take(key: string): Promise<null | unknown> {
    let claimPath: string | undefined;

    for (const filePath of this.getFilePaths(key)) {
      // Keep the configured extension on the claim file so that if the
      // process dies between the rename and the unlink, cleanup() still reaps
      // it once the entry expires rather than leaving it on disk forever.
      const candidate = `${filePath}.${randomUUID()}.claim${this.fileExtension}`;

      try {
        await rename(filePath, candidate);
        claimPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Failed to take key ${key}:`, error);
          return null;
        }
      }
    }

    if (claimPath === undefined) {
      return null;
    }

    try {
      const content = await readFile(claimPath, "utf-8");
      const entry: StorageEntry = JSON.parse(content);

      return entry.expiresAt < Date.now() ? null : entry.value;
    } catch (error) {
      console.error(`Failed to read key ${key}:`, error);
      return null;
    } finally {
      await rm(claimPath, { force: true });
    }
  }

  /**
   * Ensure storage directory exists
   */
  private async ensureDirectory(): Promise<void> {
    try {
      const stats = await stat(this.directory);
      if (!stats.isDirectory()) {
        throw new Error(`Path ${this.directory} exists but is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // 0o700, so no one else can list it. Current names are digests, but
        // earlier versions named an entry after its key, and a client code is
        // stored under `code:<the authorization code>`: a listable directory
        // was enough to harvest them, no read permission required. Applies
        // only to a directory this call creates; an existing one is left as
        // configured.
        await mkdir(this.directory, { mode: 0o700, recursive: true });
      } else {
        throw error;
      }
    }
  }

  /**
   * Get file path for a key.
   *
   * Named after the key's SHA-256 digest, not the key itself. A digest cannot
   * climb out of the directory, gives distinct keys distinct files (letter
   * case included, which macOS and Windows fold by default), always fits the
   * 255-byte file name limit, and keeps a directory listing from giving the
   * keys away. The `.` sets it apart from every name an earlier version
   * wrote, none of which has one before the extension.
   */
  private getFilePath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `sha256.${digest}${this.fileExtension}`);
  }

  /**
   * Where a key's entry may be: its own file, then the one an earlier version
   * would have written, so that entries persisted before an upgrade survive
   * it.
   */
  private getFilePaths(key: string): string[] {
    const legacyPath = this.getLegacyFilePath(key);

    return legacyPath === undefined
      ? [this.getFilePath(key)]
      : [this.getFilePath(key), legacyPath];
  }

  /**
   * The file an earlier version stored a key in, or `undefined` when its name
   * is too long to have ever been written. Every character outside
   * `[a-zA-Z0-9_-]` became `_`, so `client:a.b` and `client:a_b` shared a
   * file, and a key over the limit failed with `ENAMETOOLONG`.
   */
  private getLegacyFilePath(key: string): string | undefined {
    const name = `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${this.fileExtension}`;

    return Buffer.byteLength(name) > MAX_FILE_NAME_BYTES
      ? undefined
      : join(this.directory, name);
  }

  /**
   * One directory sweep. Always call through {@link cleanup}, which keeps
   * concurrent sweeps from overlapping.
   */
  private async runCleanup(): Promise<void> {
    try {
      await this.ensureDirectory();
      const files = await readdir(this.directory);
      const now = Date.now();

      for (const file of files) {
        if (!file.endsWith(this.fileExtension)) {
          continue;
        }

        try {
          const filePath = join(this.directory, file);
          const content = await readFile(filePath, "utf-8");
          const entry: StorageEntry = JSON.parse(content);

          if (entry.expiresAt < now) {
            await rm(filePath);
          }
        } catch (error) {
          // If file is corrupted or can't be read, delete it
          console.warn(`Failed to read/parse file ${file}, deleting:`, error);
          try {
            await rm(join(this.directory, file));
          } catch {
            // Ignore deletion errors
          }
        }
      }
    } catch (error) {
      console.error("Cleanup failed:", error);
    }
  }
}

/** What a Windows rename fails with while another handle has the file open. */
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

/**
 * rename(), tried again while Windows refuses it for a moment.
 *
 * Windows can refuse to replace a file another handle has open, which POSIX
 * never does: a get() or cleanup() reading the entry at that instant failed
 * the save with EPERM, EACCES or EBUSY. The reader lets go within
 * milliseconds, so the same rename is tried five more times, over 310ms. The
 * entry is never removed to make room, since that would hand a concurrent
 * get() the missing key the rename is there to prevent. Any other error fails
 * at once, as does any error on another platform.
 */
const renameIntoPlace = async (
  source: string,
  destination: string,
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";

      if (
        process.platform !== "win32" ||
        attempt >= 5 ||
        !TRANSIENT_RENAME_CODES.has(code)
      ) {
        throw error;
      }

      await delay(10 * 2 ** attempt);
    }
  }
};
