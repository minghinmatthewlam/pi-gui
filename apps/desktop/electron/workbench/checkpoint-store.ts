import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionRef, TurnCaptureBoundary } from "@pi-gui/session-driver";
import type { ReviewCoverage, ReviewIssue } from "../../contracts/review";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";
import { isolatedGitEnvironment } from "../platform/files/git-environment";

export interface CheckpointCaptureLimits {
  readonly timeoutMs: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

const DEFAULT_LIMITS: CheckpointCaptureLimits = {
  timeoutMs: 2_000,
  maxFiles: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
};

export type CheckpointCapture =
  | {
      readonly state: "available";
      readonly treeOid: string;
      readonly capturedAt: string;
      readonly coverage: ReviewCoverage;
      readonly fileCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    }
  | {
      readonly state: "unavailable";
      readonly code: string;
      readonly message: string;
      readonly capturedAt: string;
      readonly coverage: ReviewCoverage;
      readonly fileCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    };

export interface StoredTurnCheckpoint {
  readonly checkpointId: string;
  readonly target: SessionRef;
  readonly checkoutId: string;
  readonly checkoutPath: string;
  readonly runtimeGeneration: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly beforeEntryId: string | null;
  readonly userEntryIds: readonly string[];
  readonly assistantEntryIds: readonly string[];
  readonly lastEntryId: string | null;
  readonly outcome: "open" | "completed" | "stopped" | "failed" | "interrupted";
  readonly before: CheckpointCapture;
  readonly after: CheckpointCapture | null;
  readonly overlaps: readonly string[];
}

interface CheckpointMetadata {
  readonly version: 1;
  readonly records: readonly StoredTurnCheckpoint[];
}

export interface ResolvedTurnCheckpoint {
  readonly state: "available";
  readonly checkpointId: string;
  readonly checkoutId: string;
  readonly repositoryPath: string;
  readonly beforeTreeOid: string;
  readonly afterTreeOid: string;
  readonly capturedAt: string;
  readonly coverage: ReviewCoverage;
}

/** Owns immutable snapshot objects and small interval metadata, never the user's Git state. */
export class TurnCheckpointStore {
  readonly repositoryPath: string;
  private readonly directory: string;
  private readonly metadataPath: string;
  private readonly limits: CheckpointCaptureLimits;
  private readonly records = new Map<string, StoredTurnCheckpoint>();
  private loaded: Promise<void> | undefined;
  private gitReady: Promise<void> | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, limits: Partial<CheckpointCaptureLimits> = {}) {
    this.directory = join(userDataDir, "turn-checkpoints");
    this.repositoryPath = join(this.directory, "objects.git");
    this.metadataPath = join(this.directory, "checkpoints.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Checkpoint capture limits must be positive safe integers.");
    }
  }

  /** The adapter awaits this before a tool can run. A transition shares exactly one tree. */
  recordBoundary(boundary: TurnCaptureBoundary, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      const { opening, closing } = boundary;
      if (!opening && !closing) return;
      // Validate the entire transition before changing either interval. A late/replayed
      // observer must never replace an original baseline or a finalized comparison.
      if (
        opening &&
        (this.records.has(opening.checkpointId) || opening.checkpointId === closing?.checkpointId)
      ) {
        throw new Error("Checkpoint opening identity was already used.");
      }
      if (closing) {
        const existing = this.records.get(closing.checkpointId);
        if (existing && existing.outcome !== "open")
          throw new Error("Checkpoint interval was already finalized.");
      }
      let checkoutPath: string;
      try {
        checkoutPath = await realpath(boundary.workspace.path);
      } catch {
        checkoutPath = resolve(boundary.workspace.path);
      }
      const makeRecord = (anchor: NonNullable<typeof opening>): StoredTurnCheckpoint => ({
        checkpointId: anchor.checkpointId,
        target: { ...boundary.sessionRef },
        checkoutId: boundary.workspace.workspaceId,
        checkoutPath,
        runtimeGeneration: boundary.runtimeGeneration,
        runId: boundary.runId,
        startedAt: anchor.startedAt,
        updatedAt: boundary.timestamp,
        beforeEntryId: anchor.beforeEntryId,
        userEntryIds: [],
        assistantEntryIds: [],
        lastEntryId: null,
        outcome: "open",
        before: unavailableCapture("capture-pending", "The before capture did not finish."),
        after: null,
        overlaps: [],
      });
      for (const anchor of [opening, closing]) {
        if (!anchor) continue;
        const existing = this.records.get(anchor.checkpointId);
        if (
          existing &&
          (!sameTarget(existing.target, boundary.sessionRef) ||
            existing.checkoutId !== boundary.workspace.workspaceId ||
            existing.runtimeGeneration !== boundary.runtimeGeneration ||
            existing.runId !== boundary.runId)
        )
          throw new Error("Checkpoint identity belongs to another runtime interval.");
      }
      if (closing && !this.records.has(closing.checkpointId)) {
        this.records.set(closing.checkpointId, makeRecord(closing));
      }
      if (opening && !this.records.has(opening.checkpointId)) {
        let next = makeRecord(opening);
        for (const [id, active] of this.records) {
          if (
            active.outcome !== "open" ||
            id === closing?.checkpointId ||
            active.checkoutPath !== checkoutPath
          )
            continue;
          next = { ...next, overlaps: [...next.overlaps, id] };
          this.records.set(id, {
            ...active,
            overlaps: [...new Set([...active.overlaps, next.checkpointId])],
          });
        }
        this.records.set(next.checkpointId, next);
      }
      // An app exit during capture leaves a durable unfinished interval, never a completed one.
      await this.persist();
      const capture = await this.capture(boundary.workspace.path, signal);
      const safeCapture = signal.aborted
        ? unavailableCapture(
            "capture-aborted",
            "The capture was interrupted or exceeded its time limit.",
          )
        : capture;
      if (closing) {
        const current = this.records.get(closing.checkpointId)!;
        this.records.set(closing.checkpointId, {
          ...current,
          outcome: closing.outcome,
          updatedAt: boundary.timestamp,
          userEntryIds: [...closing.userEntryIds],
          assistantEntryIds: [...closing.assistantEntryIds],
          lastEntryId: closing.lastEntryId,
          after: closing.captureError
            ? unavailableCapture("capture-boundary-failed", closing.captureError)
            : safeCapture,
        });
      }
      if (opening) {
        const current = this.records.get(opening.checkpointId)!;
        this.records.set(opening.checkpointId, { ...current, before: safeCapture });
      }
      await this.persist();
      // Resolution is serialized behind this operation, including any abort during the write.
      if (signal.aborted) {
        const aborted = unavailableCapture(
          "capture-aborted",
          "The capture was interrupted or exceeded its time limit.",
        );
        if (closing) {
          const current = this.records.get(closing.checkpointId)!;
          this.records.set(closing.checkpointId, { ...current, after: aborted });
        }
        if (opening) {
          const current = this.records.get(opening.checkpointId)!;
          this.records.set(opening.checkpointId, { ...current, before: aborted });
        }
        await this.persist();
      }
    });
  }

  async list(target: SessionRef): Promise<readonly StoredTurnCheckpoint[]> {
    return this.enqueue(async () => {
      await this.load();
      return structuredClone(
        [...this.records.values()].filter((record) => sameTarget(record.target, target)),
      );
    });
  }

  async resolve(input: {
    target: SessionRef;
    checkoutId: string;
    checkpointId?: string;
  }): Promise<ResolvedTurnCheckpoint | ReviewIssue> {
    try {
      return await this.enqueue(async () => {
        await this.load();
        const record = input.checkpointId
          ? this.records.get(input.checkpointId)
          : [...this.records.values()]
              .filter(
                (candidate) =>
                  sameTarget(candidate.target, input.target) &&
                  candidate.checkoutId === input.checkoutId &&
                  candidate.outcome !== "open",
              )
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (
          !record ||
          !sameTarget(record.target, input.target) ||
          record.checkoutId !== input.checkoutId
        ) {
          return unavailableReview(
            "checkpoint-unavailable",
            "No captured turn exists for this task and checkout.",
          );
        }
        if (
          record.outcome === "open" ||
          record.before.state !== "available" ||
          record.after?.state !== "available"
        ) {
          const failed = record.before.state === "unavailable" ? record.before : record.after;
          return unavailableReview(
            "checkpoint-incomplete",
            failed?.state === "unavailable"
              ? failed.message
              : "This turn does not have complete before and after captures.",
          );
        }
        const notes = [...record.before.coverage.notes, ...record.after.coverage.notes];
        if (record.outcome !== "completed")
          notes.push(`This interval ended ${record.outcome}; it is not a completed turn.`);
        if (record.overlaps.length)
          notes.push(
            `Other runs overlapped this interval in the same checkout (${record.overlaps.length}). Changes cannot be attributed to this agent alone.`,
          );
        return {
          state: "available",
          checkpointId: record.checkpointId,
          checkoutId: record.checkoutId,
          repositoryPath: this.repositoryPath,
          beforeTreeOid: record.before.treeOid,
          afterTreeOid: record.after.treeOid,
          capturedAt: record.after.capturedAt,
          coverage: { state: notes.length ? "partial" : "complete", notes: [...new Set(notes)] },
        };
      });
    } catch {
      return unavailableReview(
        "checkpoint-storage-unavailable",
        "Checkpoint metadata could not be read; existing data was retained.",
      );
    }
  }

  async resolveTurn(input: {
    target: SessionRef;
    messageId: string;
  }): Promise<{ state: "available"; checkpointId: string } | ReviewIssue> {
    let records: readonly StoredTurnCheckpoint[];
    try {
      records = await this.list(input.target);
    } catch {
      return unavailableReview(
        "checkpoint-storage-unavailable",
        "Checkpoint metadata could not be read.",
      );
    }
    const record = records.find(
      (candidate) =>
        candidate.userEntryIds.includes(input.messageId) ||
        candidate.assistantEntryIds.includes(input.messageId) ||
        candidate.lastEntryId === input.messageId,
    );
    if (!record)
      return unavailableReview(
        "checkpoint-message-unavailable",
        "This message has no captured turn.",
      );
    const result = await this.resolve({
      target: input.target,
      checkoutId: record.checkoutId,
      checkpointId: record.checkpointId,
    });
    return result.state === "available"
      ? { state: "available", checkpointId: result.checkpointId }
      : result;
  }

  async capture(workspacePath: string, parentSignal?: AbortSignal): Promise<CheckpointCapture> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const failure = new AbortController();
    const signal = AbortSignal.any([
      failure.signal,
      timeout,
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const snapshotId = randomUUID();
    const indexPath = join(this.directory, "indexes", `${snapshotId}.index`);
    let spoolPath: string | undefined;
    let byteCount = 0;
    let fileCount = 0;
    try {
      signal.throwIfAborted();
      await this.prepareGit(signal);
      await mkdir(dirname(indexPath), { recursive: true });
      const root = await realpath(workspacePath);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new CaptureError("checkout-changing", "The checkout root changed during capture.");
      const repositoryRoot = stripLine(await git(root, ["rev-parse", "--show-toplevel"], signal));
      if ((await realpath(repositoryRoot)) !== root)
        throw new CaptureError(
          "checkout-root-required",
          "Turn captures require the Git checkout root.",
        );
      const [trackedOutput, otherOutput] = await Promise.all([
        git(root, ["ls-files", "--stage", "-v", "-z"], signal),
        git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
      ]);
      const paths = new Set<string>();
      for (const entry of nulRecords(trackedOutput)) {
        const match = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
        if (!match)
          throw new CaptureError(
            "inventory-invalid",
            "Git returned an unreadable tracked-file inventory.",
          );
        if (match[1]!.toUpperCase() === "S")
          throw new CaptureError(
            "sparse-checkout",
            "Sparse checkout paths are not yet supported by turn captures.",
          );
        if (match[2] === "160000")
          throw new CaptureError(
            "submodule",
            "Submodule contents are excluded; this turn capture is unavailable.",
          );
        if (match[4] !== "0")
          throw new CaptureError(
            "conflicted-checkout",
            "Resolve Git index conflicts before capturing a complete turn.",
          );
        paths.add(match[5]!);
      }
      for (const path of nulRecords(otherOutput)) paths.add(path);
      if (paths.size > this.limits.maxFiles)
        throw new CaptureError(
          "file-limit",
          `The checkout exceeds the ${this.limits.maxFiles}-file capture limit.`,
        );
      const entries = [...paths];
      spoolPath = await mkdtemp(join(this.directory, "capture-"));
      const captureDirectory = spoolPath;
      const spooled: { path: string; mode: string; name: string }[] = [];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (cursor < entries.length) {
          signal.throwIfAborted();
          const ordinal = cursor++;
          const path = entries[ordinal]!;
          const file = await readSnapshotFile(root, rootStat, path, signal, (size) => {
            if (size > this.limits.maxFileBytes || byteCount + size > this.limits.maxBytes) {
              throw new CaptureError(
                "byte-limit",
                "The checkout exceeds the bounded turn-capture size limit.",
              );
            }
            byteCount += size;
          });
          if (!file) continue; // A tracked deletion is represented by absence from the new tree.
          const name = `blob-${ordinal}`;
          await writeFile(join(captureDirectory, name), file.bytes, {
            flag: "wx",
            mode: 0o600,
            signal,
          });
          signal.throwIfAborted();
          spooled.push({ path, mode: file.mode, name });
          fileCount += 1;
        }
      });
      try {
        await Promise.all(workers);
      } catch (error) {
        failure.abort();
        await Promise.allSettled(workers);
        throw error;
      }
      signal.throwIfAborted();
      // Git only opens freshly created private files with synthetic relative names. Original
      // paths (including tabs/newlines) never enter this line-based input or get reopened by Git.
      const objectOutput = await git(
        captureDirectory,
        ["--git-dir", this.repositoryPath, "hash-object", "--stdin-paths", "--no-filters", "-w"],
        signal,
        Buffer.from(spooled.map((entry) => `${entry.name}\n`).join("")),
      );
      signal.throwIfAborted();
      const objectIds = objectOutput.length ? stripLine(objectOutput).split(/\r?\n/) : [];
      if (
        objectIds.length !== spooled.length ||
        objectIds.some((oid) => !/^[a-f0-9]{40}$/.test(oid))
      ) {
        throw new CaptureError(
          "object-invalid",
          "Git returned an invalid snapshot object inventory.",
        );
      }
      const indexEntries = spooled.map(
        (entry, index) => `${entry.mode} ${objectIds[index]}\t${entry.path}\0`,
      );
      await rm(captureDirectory, { recursive: true, force: true });
      spoolPath = undefined;
      signal.throwIfAborted();
      const indexEnvironment = { GIT_INDEX_FILE: indexPath };
      await git(this.repositoryPath, ["read-tree", "--empty"], signal, undefined, indexEnvironment);
      await git(
        this.repositoryPath,
        ["update-index", "-z", "--index-info"],
        signal,
        Buffer.from(indexEntries.join("")),
        indexEnvironment,
      );
      const treeOid = stripLine(
        await git(this.repositoryPath, ["write-tree"], signal, undefined, indexEnvironment),
      );
      if (!/^[a-f0-9]{40}$/.test(treeOid))
        throw new CaptureError("tree-invalid", "Git returned an invalid snapshot tree.");
      signal.throwIfAborted();
      await git(
        this.repositoryPath,
        ["update-ref", `refs/pi-gui/snapshots/${snapshotId}`, treeOid],
        signal,
      );
      signal.throwIfAborted();
      return {
        state: "available",
        treeOid,
        capturedAt: new Date().toISOString(),
        coverage: { state: "complete", notes: [] },
        fileCount,
        byteCount,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      failure.abort();
      const result =
        timeout.aborted || parentSignal?.aborted
          ? unavailableCapture(
              "capture-aborted",
              "The capture was interrupted or exceeded its time limit.",
            )
          : error instanceof CaptureError
            ? unavailableCapture(error.code, error.message)
            : unavailableCapture(
                "capture-failed",
                "The checkout could not be captured completely; no partial diff will be shown.",
              );
      return { ...result, fileCount, byteCount, durationMs: Date.now() - started };
    } finally {
      if (spoolPath) await rm(spoolPath, { recursive: true, force: true });
      // These are this capture's newly created scratch indexes, not user or checkpoint data.
      await Promise.all(
        [indexPath, `${indexPath}.lock`].map(async (path) => {
          try {
            await unlink(path);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }),
      );
    }
  }

  private prepareGit(signal: AbortSignal): Promise<void> {
    this.gitReady ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await lstat(this.repositoryPath);
        if (!existing.isDirectory() || existing.isSymbolicLink())
          throw new Error("Invalid checkpoint repository.");
      } catch (error) {
        if (!isMissing(error)) throw error;
        const initializingPath = join(this.directory, `objects.git.initializing.${randomUUID()}`);
        await git(
          this.directory,
          ["init", "--bare", "--template=", "--object-format=sha1", initializingPath],
          signal,
        );
        if (
          stripLine(await git(initializingPath, ["rev-parse", "--is-bare-repository"], signal)) !==
          "true"
        ) {
          throw new Error("Checkpoint repository initialization did not finish.");
        }
        signal.throwIfAborted();
        // Publish only a validated repository. A killed init leaves its unique staging path
        // available for inspection and cannot poison the next attempt's destination.
        await rename(initializingPath, this.repositoryPath);
      }
      if (
        stripLine(await git(this.repositoryPath, ["rev-parse", "--is-bare-repository"], signal)) !==
        "true"
      )
        throw new Error("Checkpoint repository must be bare.");
    })().catch((error: unknown) => {
      this.gitReady = undefined;
      throw error;
    });
    return this.gitReady;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const result = await readJsonWithBackup(this.metadataPath);
      if (result.corrupted && !result.recovered)
        throw new Error("Invalid checkpoint metadata; original data retained.");
      const metadata =
        result.value === undefined
          ? { version: 1 as const, records: [] }
          : decodeMetadata(result.value);
      let interrupted = false;
      for (const record of metadata.records) {
        if (record.outcome === "open") {
          interrupted = true;
          this.records.set(record.checkpointId, {
            ...record,
            outcome: "interrupted",
            after: unavailableCapture(
              "runtime-interrupted",
              "The app exited before this interval's final capture.",
            ),
          });
        } else this.records.set(record.checkpointId, record);
      }
      if (interrupted) await this.persist();
    })().catch((error: unknown) => {
      // A transient read failure must not disable captures until restart.
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  private persist(): Promise<void> {
    const metadata: CheckpointMetadata = { version: 1, records: [...this.records.values()] };
    decodeMetadata(metadata);
    return writeFileAtomicQueued(
      this.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      decodeMetadata,
    );
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action, action);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class CaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readSnapshotFile(
  root: string,
  rootStat: Stats,
  path: string,
  signal: AbortSignal,
  reserve: (size: number) => void,
): Promise<{ mode: string; bytes: Buffer } | null> {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
    path.includes("\0") ||
    (sep === "\\" && path.includes("\\"))
  )
    throw new CaptureError("unsafe-path", "The checkout contains an unsafe capture path.");
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(`..${sep}`))
    throw new CaptureError("unsafe-path", "A capture path escapes the checkout.");
  const ancestors: { path: string; stat: Stats }[] = [{ path: root, stat: rootStat }];
  let parent = root;
  for (const component of parts.slice(0, -1)) {
    parent = join(parent, component);
    let stat: Stats;
    try {
      stat = await lstat(parent);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new CaptureError(
        "unsafe-symlink",
        "A tracked path now passes through a symlink or non-directory.",
      );
    ancestors.push({ path: parent, stat });
  }
  let before: Stats;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  signal.throwIfAborted();
  const verifyAncestors = async () => {
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path);
      if (!current.isDirectory() || !sameIdentity(ancestor.stat, current))
        throw new CaptureError("checkout-changing", "A parent directory changed during capture.");
    }
  };
  if (before.isSymbolicLink()) {
    const bytes = await readlink(absolute, { encoding: "buffer" });
    reserve(bytes.length);
    await verifyAncestors();
    if (!sameVersion(before, await lstat(absolute)))
      throw new CaptureError("checkout-changing", "A symlink changed during capture.");
    return { mode: "120000", bytes };
  }
  if (!before.isFile())
    throw new CaptureError(
      "unsupported-file",
      "Special files and nested repositories are excluded from turn captures.",
    );
  reserve(before.size);
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    // Check the opened inode before reading bytes: ancestor replacement cannot redirect a read.
    if (!sameVersion(before, await handle.stat()))
      throw new CaptureError("checkout-changing", "A file changed before it could be captured.");
    await verifyAncestors();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset,
      );
      if (read.bytesRead === 0)
        throw new CaptureError("checkout-changing", "A file was truncated during capture.");
      offset += read.bytesRead;
    }
    signal.throwIfAborted();
    if (!sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(absolute)))
      throw new CaptureError("checkout-changing", "A file changed during capture.");
    await verifyAncestors();
    return { mode: before.mode & 0o111 ? "100755" : "100644", bytes };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function git(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  input?: Buffer,
  extraEnv: Record<string, string> = {},
): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = execFile(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        ...args,
      ],
      {
        cwd,
        // Keep normal global/system exclude configuration, but never inherited Git repository overrides.
        env: isolatedGitEnvironment(extraEnv),
        encoding: "buffer",
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : accept(stdout)),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

function stripLine(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/\r?\n$/, "");
}

function nulRecords(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text).equals(buffer) || (text && !text.endsWith("\0")))
    throw new CaptureError(
      "inventory-encoding",
      "Git paths cannot be represented safely by the app.",
    );
  return text ? text.slice(0, -1).split("\0") : [];
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameTarget(left: SessionRef, right: SessionRef): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}

function unavailableCapture(code: string, message: string): CheckpointCapture {
  return {
    state: "unavailable",
    code,
    message,
    capturedAt: new Date().toISOString(),
    coverage: { state: "partial", notes: [message] },
    fileCount: 0,
    byteCount: 0,
    durationMs: 0,
  };
}

function unavailableReview(code: string, message: string): ReviewIssue {
  return { state: "unavailable", code, message };
}

function decodeMetadata(value: unknown): CheckpointMetadata {
  const root = metadataRecord(value, ["version", "records"]);
  if (root.version !== 1 || !Array.isArray(root.records))
    throw new Error("Unsupported checkpoint metadata; original data retained.");
  const records = root.records.map((value: unknown): StoredTurnCheckpoint => {
    const record = metadataRecord(value, [
      "checkpointId",
      "target",
      "checkoutId",
      "checkoutPath",
      "runtimeGeneration",
      "runId",
      "startedAt",
      "updatedAt",
      "beforeEntryId",
      "userEntryIds",
      "assistantEntryIds",
      "lastEntryId",
      "outcome",
      "before",
      "after",
      "overlaps",
    ]);
    const target = metadataRecord(record.target, ["workspaceId", "sessionId"]);
    const outcome = record.outcome;
    if (
      outcome !== "open" &&
      outcome !== "completed" &&
      outcome !== "stopped" &&
      outcome !== "failed" &&
      outcome !== "interrupted"
    )
      throw new Error("Invalid checkpoint outcome.");
    return {
      checkpointId: metadataText(record.checkpointId),
      target: {
        workspaceId: metadataText(target.workspaceId),
        sessionId: metadataText(target.sessionId),
      },
      checkoutId: metadataText(record.checkoutId),
      checkoutPath: metadataText(record.checkoutPath),
      runtimeGeneration: metadataText(record.runtimeGeneration),
      runId: metadataText(record.runId),
      startedAt: metadataText(record.startedAt),
      updatedAt: metadataText(record.updatedAt),
      beforeEntryId: record.beforeEntryId === null ? null : metadataText(record.beforeEntryId),
      lastEntryId: record.lastEntryId === null ? null : metadataText(record.lastEntryId),
      userEntryIds: metadataTexts(record.userEntryIds),
      assistantEntryIds: metadataTexts(record.assistantEntryIds),
      overlaps: metadataTexts(record.overlaps),
      outcome,
      before: decodeCapture(record.before),
      after: record.after === null ? null : decodeCapture(record.after),
    };
  });
  if (new Set(records.map((record) => record.checkpointId)).size !== records.length)
    throw new Error("Duplicate checkpoint identity.");
  return { version: 1, records };
}

function decodeCapture(value: unknown): CheckpointCapture {
  const record = metadataRecord(value, [
    "state",
    "treeOid",
    "capturedAt",
    "coverage",
    "fileCount",
    "byteCount",
    "durationMs",
    "code",
    "message",
  ]);
  const coverage = metadataRecord(record.coverage, ["state", "notes"]);
  if (coverage.state !== "complete" && coverage.state !== "partial")
    throw new Error("Invalid checkpoint coverage.");
  const parsedCoverage: ReviewCoverage = {
    state: coverage.state,
    notes: metadataTexts(coverage.notes),
  };
  const common = {
    capturedAt: metadataText(record.capturedAt),
    coverage: parsedCoverage,
    fileCount: metadataNumber(record.fileCount),
    byteCount: metadataNumber(record.byteCount),
    durationMs: metadataNumber(record.durationMs),
  };
  if (record.state === "unavailable")
    return {
      state: "unavailable",
      code: metadataText(record.code),
      message: metadataText(record.message),
      ...common,
    };
  if (
    record.state !== "available" ||
    typeof record.treeOid !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.treeOid) ||
    !Number.isSafeInteger(record.fileCount) ||
    Number(record.fileCount) < 0 ||
    !Number.isSafeInteger(record.byteCount) ||
    Number(record.byteCount) < 0
  )
    throw new Error("Invalid checkpoint capture.");
  return { state: "available", treeOid: record.treeOid, ...common };
}

function metadataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid checkpoint metadata; original data retained.");
  return value as Record<string, unknown>;
}

function metadataText(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid checkpoint reference.");
  return value;
}

function metadataTexts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid checkpoint references.");
  return value.map(metadataText);
}

function metadataNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid checkpoint metric.");
  return value;
}
