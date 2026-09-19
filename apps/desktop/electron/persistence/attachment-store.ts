import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";
import type { ComposerAttachment } from "../../contracts/desktop-state";

export class AttachmentStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "attachments");
  }

  async read(sessionKey: string): Promise<ComposerAttachment[] | undefined> {
    const result = await readJsonWithBackup(this.filePath(sessionKey));
    if (result.corrupted && !result.recovered) {
      throw new Error(
        `Invalid saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    if (result.corrupted) {
      console.error(
        `[attachment-store] corrupt entry for "${sessionKey}" in ${this.rootDir}` +
          (result.recovered ? " — recovered from backup" : " — no usable backup"),
      );
    }
    return result.value === undefined ? undefined : decodeAttachments(result.value);
  }

  async write(sessionKey: string, data: readonly ComposerAttachment[]): Promise<void> {
    decodeAttachments(data);
    await writeFileAtomicQueued(
      this.filePath(sessionKey),
      `${JSON.stringify(data, null, 2)}\n`,
      decodeAttachments,
    );
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
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
          `[attachment-store] skipping malformed filename "${name}" in ${this.rootDir}`,
          error,
        );
      }
    }
    return keys;
  }

  async remove(sessionKey: string): Promise<void> {
    // Never prune an entry whose contents we cannot understand.
    if ((await readJsonWithBackup(this.filePath(sessionKey))).corrupted) {
      throw new Error(
        `Cannot prune corrupt saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    await this.read(sessionKey);
    await this.unlinkIfPresent(this.filePath(sessionKey));
    await this.unlinkIfPresent(`${this.filePath(sessionKey)}.bak`);
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}

export function decodeAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value))
    throw new Error("Invalid saved attachments: expected an array; original data was retained.");
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid saved attachment at index ${index}.`);
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string"
    )
      throw new Error(`Invalid saved attachment metadata at index ${index}.`);
    const allowedKeys =
      item.kind === "file"
        ? ["id", "kind", "name", "mimeType", "fsPath", "sizeBytes"]
        : ["id", "kind", "name", "mimeType", "data"];
    if (Object.keys(item).some((key) => !allowedKeys.includes(key)))
      throw new Error(
        `Invalid saved attachment at index ${index}: unsupported field; original data was retained.`,
      );
    const base = { id: item.id, name: item.name, mimeType: item.mimeType };
    if ((item.kind === "image" || item.kind === undefined) && typeof item.data === "string")
      return { ...base, kind: "image", data: item.data };
    if (
      item.kind === "file" &&
      typeof item.fsPath === "string" &&
      (item.sizeBytes === undefined ||
        (typeof item.sizeBytes === "number" &&
          Number.isFinite(item.sizeBytes) &&
          item.sizeBytes >= 0))
    )
      return {
        ...base,
        kind: "file",
        fsPath: item.fsPath,
        ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
      };
    throw new Error(
      `Invalid saved attachment payload at index ${index}; original data was retained.`,
    );
  });
}
