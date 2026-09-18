import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";

export class JsonFileStore<T> {
  private readonly rootDir: string;

  constructor(userDataDir: string, subdir: string) {
    this.rootDir = join(userDataDir, subdir);
  }

  async read(sessionKey: string): Promise<T | undefined> {
    const result = await readJsonWithBackup<T>(this.filePath(sessionKey));
    if (result.corrupted) {
      console.error(
        `[json-file-store] corrupt entry for "${sessionKey}" in ${this.rootDir}` +
          (result.recovered
            ? " — recovered from backup"
            : " — no usable backup, treating as empty"),
      );
    }
    return result.value;
  }

  async write(sessionKey: string, data: T): Promise<void> {
    await writeFileAtomicQueued(this.filePath(sessionKey), `${JSON.stringify(data, null, 2)}\n`);
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }

    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        keys.push(decodeURIComponent(name.slice(0, -".json".length)));
      } catch (error) {
        // A single malformed filename must not abort the whole listing; that
        // would silently disable attachment pruning for every key.
        console.error(
          `[json-file-store] skipping malformed filename "${name}" in ${this.rootDir}`,
          error,
        );
      }
    }
    return keys;
  }

  async remove(sessionKey: string): Promise<void> {
    await this.unlinkIfPresent(this.filePath(sessionKey));
    await this.unlinkIfPresent(`${this.filePath(sessionKey)}.bak`);
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Already gone.
    }
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}
