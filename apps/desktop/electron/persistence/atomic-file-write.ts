import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const writeQueueByPath = new Map<string, Promise<void>>();

/**
 * Write a file durably via temp-file + rename, serializing concurrent writes to
 * the same path. The temp file is fsync'd before it is renamed into place and
 * the containing directory is fsync'd afterwards, so a crash or power loss can
 * never leave a renamed-but-empty target that later reads back as `{}`. The
 * previous good version is promoted to a `<path>.bak` sibling before the new
 * bytes take its place, so {@link readJsonWithBackup} can recover from it if the
 * primary file is ever found truncated or corrupt.
 */
export async function writeFileAtomicQueued(
  filePath: string,
  contents: string,
  validateExisting: (value: unknown) => unknown,
): Promise<void> {
  await enqueueWrite(filePath, async () => {
    const existing = await readJsonWithBackup(filePath);
    if (existing.corrupted && !existing.recovered) {
      throw new Error(
        `Cannot overwrite invalid saved data at ${filePath}; repair or restore it first.`,
      );
    }
    if (existing.value !== undefined) validateExisting(existing.value);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await promoteToTarget(tmpPath, filePath, existing.corrupted);
    } catch (error) {
      await cleanupTempFile(tmpPath);
      throw error;
    }

    await fsyncDir(dir);
  });
}

export interface AtomicReadResult<T> {
  /** Parsed value, or undefined when neither the primary nor the backup was usable. */
  readonly value: T | undefined;
  /** The primary file existed but failed to parse. */
  readonly corrupted: boolean;
  /** The value was recovered from the `.bak` sibling because the primary was missing or corrupt. */
  readonly recovered: boolean;
}

/**
 * Read and JSON-parse a file written by {@link writeFileAtomicQueued},
 * transparently recovering from the `.bak` sibling when the primary file is
 * missing (e.g. a crash between promoting the backup and renaming the new
 * temp into place) or corrupt. A missing primary with no backup is the normal
 * "never written" case and is reported without the `corrupted` flag so callers
 * do not log noise on first run.
 */
export async function readJsonWithBackup(filePath: string): Promise<AtomicReadResult<unknown>> {
  const primary = await tryReadParse(filePath);
  if (primary.status === "ok") {
    return { value: primary.value, corrupted: false, recovered: false };
  }

  const backup = await tryReadParse(`${filePath}.bak`);
  if (backup.status === "ok") {
    return { value: backup.value, corrupted: primary.status === "corrupt", recovered: true };
  }

  return {
    value: undefined,
    corrupted: primary.status === "corrupt" || backup.status === "corrupt",
    recovered: false,
  };
}

type ReadParseResult =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "missing" }
  | { readonly status: "corrupt" };

async function tryReadParse(filePath: string): Promise<ReadParseResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }

  try {
    return { status: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { status: "corrupt" };
  }
}

async function promoteToTarget(
  tmpPath: string,
  filePath: string,
  preserveCorrupt: boolean,
): Promise<void> {
  // Preserve the current good file as a `.bak` before overwriting so a truncated
  // or corrupt target can be recovered on read. On the first write there is no
  // target yet, so a missing-file error here is expected and ignored.
  try {
    // Recovery never replaces the good backup with corrupt bytes. Retain the
    // damaged primary separately before installing the recovered state.
    await renameReplace(
      filePath,
      preserveCorrupt ? `${filePath}.corrupt.${randomUUID()}` : `${filePath}.bak`,
    );
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await renameReplace(tmpPath, filePath);
}

async function renameReplace(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
    return;
  } catch (error) {
    if (!isReplaceRenameError(error)) {
      throw error;
    }
  }

  // Windows rename cannot atomically replace an existing file; remove the
  // destination first, then rename into the now-free path.
  await cleanupTempFile(dest);
  await rename(src, dest);
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is a best-effort durability barrier. Some platforms
    // (notably Windows) reject opening a directory for fsync; that must never
    // fail the write, only weaken the crash guarantee on those platforms.
  } finally {
    await handle?.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isReplaceRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM")
  );
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function enqueueWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueueByPath.set(filePath, next);

  try {
    await next;
  } finally {
    if (writeQueueByPath.get(filePath) === next) {
      writeQueueByPath.delete(filePath);
    }
  }
}
