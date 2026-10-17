/**
 * Disk-based Token Storage Implementation
 * Provides persistent file-based storage for OAuth tokens and transaction state
 */

import { randomUUID } from "crypto";
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
    const filePath = this.getFilePath(key);
    try {
      await rm(filePath);
    } catch (error) {
      // File might not exist, which is fine
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to delete key ${key}:`, error);
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
    const filePath = this.getFilePath(key);

    try {
      const content = await readFile(filePath, "utf-8");
      const entry: StorageEntry = JSON.parse(content);

      // Check if expired
      if (entry.expiresAt < Date.now()) {
        await rm(filePath);
        return null;
      }

      return entry.value;
    } catch (error) {
      // File doesn't exist or is corrupted
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      console.error(`Failed to read key ${key}:`, error);
      return null;
    }
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
    const filePath = this.getFilePath(key);
    // Keep the configured extension on the claim file so that if the process
    // dies between the rename and the unlink, cleanup() still reaps it once
    // the entry expires rather than leaving it on disk forever.
    const claimPath = `${filePath}.${randomUUID()}.claim${this.fileExtension}`;

    try {
      await rename(filePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to take key ${key}:`, error);
      }
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
        // 0o700, because the filenames leak on their own: getFilePath() derives
        // them from the storage key, and a client code is stored under
        // `code:<the authorization code>`. A listable directory is enough to
        // harvest them, no read permission required. Applies only to a
        // directory this call creates; an existing one is left as configured.
        await mkdir(this.directory, { mode: 0o700, recursive: true });
      } else {
        throw error;
      }
    }
  }

  /**
   * Get file path for a key
   */
  private getFilePath(key: string): string {
    // Sanitize key to prevent directory traversal
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.directory, `${sanitizedKey}${this.fileExtension}`);
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
