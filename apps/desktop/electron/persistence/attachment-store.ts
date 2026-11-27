import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";
import type { ComposerAttachment } from "../../contracts/desktop-state";

// Session keys embed the absolute workspace path, so the percent-encoded key can
// exceed the 255-byte file name limit (e.g. decomposed Hangul on macOS SMB shares
// encodes each syllable to 18–27 bytes). Longer keys are stored under a
// fixed-length hash; the budget leaves room for ".json" and the
// ".<pid>.<uuid>.tmp" suffix that atomic writes append.
const MAX_ENCODED_KEY_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;
// encodeURIComponent always escapes "=", so a hashed name never collides with an
// encoded key.
const HASHED_NAME_PREFIX = "sha256=";

// The first name is where the key is written. Earlier versions saved any key whose
// plain name still fit next to the temp suffix (up to ~205 encoded bytes), so a
// hashed key also answers to its plain name when that name fits; reading and
// pruning honor it so upgrading does not orphan attachments already on disk.
function fileNamesForKey(sessionKey: string): [string, ...string[]] {
  const encoded = encodeURIComponent(sessionKey);
  const plain = `${encoded}.json`;
  if (encoded.length <= MAX_ENCODED_KEY_LENGTH) {
    return [plain];
  }
  const hashed = `${HASHED_NAME_PREFIX}${createHash("sha256").update(sessionKey).digest("hex")}.json`;
  return plain.length <= MAX_FILE_NAME_LENGTH ? [hashed, plain] : [hashed];
}

export class AttachmentStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "attachments");
  }

  async read(sessionKey: string): Promise<ComposerAttachment[] | undefined> {
    for (const name of fileNamesForKey(sessionKey)) {
      const entry = await this.readEntry(name);
      if (entry !== undefined) {
        return entry;
      }
    }
    return undefined;
  }

  async readAll(): Promise<ComposerAttachment[][]> {
    const entries = await Promise.all(
      (await this.listEntries()).map((name) => this.readEntry(name)),
    );
    return entries.filter((entry) => entry !== undefined);
  }

  async write(sessionKey: string, data: readonly ComposerAttachment[]): Promise<void> {
    decodeAttachments(data);
    await writeFileAtomicQueued(
      this.entryPath(fileNamesForKey(sessionKey)[0]),
      `${JSON.stringify(data, null, 2)}\n`,
      decodeAttachments,
    );
  }

  async remove(sessionKey: string): Promise<void> {
    for (const name of fileNamesForKey(sessionKey)) {
      await this.removeEntry(name);
    }
  }

  async pruneExcept(activeKeys: ReadonlySet<string>): Promise<void> {
    const keep = new Set([...activeKeys].flatMap(fileNamesForKey));
    const entries = await this.listEntries();
    await Promise.all(
      entries.filter((name) => !keep.has(name)).map((name) => this.removeEntry(name)),
    );
  }

  private async listEntries(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }

    return entries.filter((name) => {
      if (!name.endsWith(".json")) {
        return false;
      }
      try {
        decodeURIComponent(name.slice(0, -".json".length));
        return true;
      } catch (error) {
        // A single malformed filename must not abort the whole listing; that
        // would silently disable attachment pruning for every key.
        console.error(
          `[attachment-store] skipping malformed filename "${name}" in ${this.rootDir}`,
          error,
        );
        return false;
      }
    });
  }

  private async readEntry(name: string): Promise<ComposerAttachment[] | undefined> {
    const path = this.entryPath(name);
    const result = await readJsonWithBackup(path);
    if (result.corrupted && !result.recovered) {
      throw new Error(`Invalid saved attachments at ${path}; original data was retained.`);
    }
    if (result.corrupted) {
      console.error(
        `[attachment-store] corrupt entry "${name}" in ${this.rootDir}` +
          (result.recovered ? " — recovered from backup" : " — no usable backup"),
      );
    }
    return result.value === undefined ? undefined : decodeAttachments(result.value);
  }

  private async removeEntry(name: string): Promise<void> {
    const path = this.entryPath(name);
    // Never prune an entry whose contents we cannot understand.
    if ((await readJsonWithBackup(path)).corrupted) {
      throw new Error(
        `Cannot prune corrupt saved attachments at ${path}; original data was retained.`,
      );
    }
    await this.readEntry(name);
    await this.unlinkIfPresent(path);
    await this.unlinkIfPresent(`${path}.bak`);
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

  private entryPath(name: string): string {
    return join(this.rootDir, name);
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
