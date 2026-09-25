import { randomBytes, randomUUID } from "node:crypto";
import { link, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { writeJsonFileAtomic } from "@pi-gui/catalogs/node/atomic-write";
import { isMissingFileError } from "@pi-gui/catalogs/node";

/**
 * Single-writer lease convention for pi session files.
 *
 * When pi-gui binds a live runtime to a session's JSONL, it claims a sibling
 * `<sessionFile>.lease` file recording who holds it. Between pi-gui processes
 * the lease is exclusive: it is created with an atomic exclusive link, kept
 * fresh by a heartbeat while the holder lives, and removed only by its owner.
 * The pi CLI knows nothing about it, so its presence must never block reading
 * or displaying a session.
 *
 * The suffix is `.lease`, chosen because pi's SessionManager discovers and
 * opens sessions strictly by `endsWith(".jsonl")` (verified in
 * node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js),
 * so a `.jsonl.lease` sibling is invisible to its listing and open logic.
 *
 * A lease is dead (and may be taken over) when we can prove the holder is
 * gone: on the same host, when its pid is no longer alive; on any host, when
 * its heartbeat has not refreshed the file mtime within the TTL.
 */

export const LEASE_SUFFIX = ".lease";

/** A lease is stale after this long without its holder refreshing the mtime. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** How often a holder refreshes its leases; comfortably below the TTL. */
export const DEFAULT_LEASE_HEARTBEAT_MS = DEFAULT_LEASE_TTL_MS / 5;

/** Surface tag written into leases held by this app. */
export const PI_GUI_LEASE_SURFACE = "pi-gui";

export interface LeaseInfo {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly surface: string;
  /** Per-process owner token. Absent in leases written before tokens existed. */
  readonly token?: string;
}

export interface LeaseSnapshot {
  readonly info: LeaseInfo;
  /** Modification time of the lease file, in epoch milliseconds. */
  readonly mtimeMs: number;
}

export interface LeaseIdentity {
  readonly pid: number;
  readonly hostname: string;
  readonly token?: string;
}

export interface LeaseStalenessOptions {
  readonly now: number;
  readonly ttlMs: number;
  readonly self: LeaseIdentity;
  readonly isPidAlive: (pid: number) => boolean;
}

/** Error thrown when a session cannot be bound because a live foreign lease holds it. */
export class SessionLeasedError extends Error {
  readonly code = "SESSION_LEASED";
  readonly holder: LeaseInfo;

  constructor(sessionFile: string, holder: LeaseInfo) {
    super(
      `Session file ${sessionFile} is held by ${holder.surface} (pid ${holder.pid} on ${holder.hostname}, since ${holder.startedAt}).`,
    );
    this.name = "SessionLeasedError";
    this.holder = holder;
  }
}

export function sessionLeasePath(sessionFile: string): string {
  return `${sessionFile}${LEASE_SUFFIX}`;
}

export function currentLeaseIdentity(): LeaseIdentity {
  return { pid: process.pid, hostname: hostname(), token: randomUUID() };
}

/** Tokens decide ownership when both sides have one; older leases fall back to pid + host. */
export function isSameHolder(info: LeaseInfo | LeaseIdentity, self: LeaseIdentity): boolean {
  if (info.token && self.token) {
    return info.token === self.token;
  }
  return info.pid === self.pid && info.hostname === self.hostname;
}

/** Whether a running process with `pid` exists (best-effort, same-host only). */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists but owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pure staleness decision so it can be unit-tested with injected clock/pid
 * checks. Dead means "safe to overwrite": the holder's pid is gone (same host)
 * or the lease has not been refreshed within the TTL.
 */
export function isLeaseDead(snapshot: LeaseSnapshot, opts: LeaseStalenessOptions): boolean {
  const sameHost = snapshot.info.hostname === opts.self.hostname;
  if (sameHost && !opts.isPidAlive(snapshot.info.pid)) {
    return true;
  }
  return opts.now - snapshot.mtimeMs > opts.ttlMs;
}

/**
 * Whether an existing lease should block us from binding a runtime. Our own
 * prior lease never blocks; a foreign lease blocks only while it is alive.
 */
export function leaseBlocksBinding(snapshot: LeaseSnapshot, opts: LeaseStalenessOptions): boolean {
  if (isSameHolder(snapshot.info, opts.self)) {
    return false;
  }
  return !isLeaseDead(snapshot, opts);
}

/** Read a lease. Missing and corrupt leases both read as undefined. */
export async function readLeaseSnapshot(leasePath: string): Promise<LeaseSnapshot | undefined> {
  return (await readLeaseFileState(leasePath))?.snapshot;
}

function parseLeaseInfo(raw: string): LeaseInfo | undefined {
  let parsed: Partial<LeaseInfo>;
  try {
    parsed = JSON.parse(raw) as Partial<LeaseInfo>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed?.pid !== "number" ||
    typeof parsed.hostname !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.surface !== "string"
  ) {
    return undefined;
  }
  return {
    pid: parsed.pid,
    hostname: parsed.hostname,
    startedAt: parsed.startedAt,
    surface: parsed.surface,
    ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
  };
}

export async function writeLeaseFile(leasePath: string, info: LeaseInfo): Promise<void> {
  await writeJsonFileAtomic(leasePath, info);
}

export async function removeLeaseFile(leasePath: string): Promise<void> {
  await rm(leasePath, { force: true });
}

/** Build the lease record this app writes for `sessionFile`. */
export function buildOwnLease(self: LeaseIdentity, now: number): LeaseInfo {
  return {
    pid: self.pid,
    hostname: self.hostname,
    startedAt: new Date(now).toISOString(),
    surface: PI_GUI_LEASE_SURFACE,
    ...(self.token ? { token: self.token } : {}),
  };
}

export type LeaseAcquireResult =
  { readonly status: "acquired" } | { readonly status: "held"; readonly holder: LeaseInfo };

const ACQUIRE_ATTEMPTS = 3;

/**
 * Claim `leasePath` for `opts.self`. Succeeds when the lease is absent, already
 * ours, or provably dead; reports the holder when a live foreign lease exists.
 * Creation is exclusive, so two processes racing for an absent lease cannot
 * both win. Filesystem failures throw: a caller that cannot hold the lease
 * must not bind a writable runtime.
 */
export async function acquireLeaseFile(
  leasePath: string,
  opts: LeaseStalenessOptions,
): Promise<LeaseAcquireResult> {
  const content = serializeLease(buildOwnLease(opts.self, opts.now));
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    if (await createLeaseExclusive(leasePath, content)) {
      return { status: "acquired" };
    }
    const current = await readLeaseFileState(leasePath);
    if (!current) {
      continue; // Released between our create and read; try again.
    }
    if (current.snapshot) {
      if (isSameHolder(current.snapshot.info, opts.self)) {
        await writeLeaseFile(leasePath, buildOwnLease(opts.self, opts.now));
        return { status: "acquired" };
      }
      if (!isLeaseDead(current.snapshot, opts)) {
        return { status: "held", holder: current.snapshot.info };
      }
    }
    // Dead or unreadable: remove it only if nobody replaced it since we looked,
    // so a racing taker's fresh lease is never deleted.
    const again = await readLeaseFileState(leasePath);
    if (again && again.raw === current.raw && again.mtimeMs === current.mtimeMs) {
      await rm(leasePath, { force: true });
    }
  }
  throw new Error(`Could not acquire session lease ${leasePath}: it kept changing.`);
}

/**
 * Heartbeat: bump the lease mtime if we still own it. Returns "lost" when the
 * lease is gone or now belongs to someone else.
 */
export async function refreshLeaseFile(
  leasePath: string,
  self: LeaseIdentity,
  now: number,
): Promise<"refreshed" | "lost"> {
  const snapshot = await readLeaseSnapshot(leasePath);
  if (!snapshot || !isSameHolder(snapshot.info, self)) {
    return "lost";
  }
  const time = new Date(now);
  await utimes(leasePath, time, time);
  return "refreshed";
}

/** Remove the lease only if we own it, so we never delete a successor's lease. */
export async function releaseLeaseFile(leasePath: string, self: LeaseIdentity): Promise<void> {
  const snapshot = await readLeaseSnapshot(leasePath);
  if (snapshot && isSameHolder(snapshot.info, self)) {
    await removeLeaseFile(leasePath);
  }
}

function serializeLease(info: LeaseInfo): string {
  return `${JSON.stringify(info, null, 2)}\n`;
}

/**
 * Create the lease only if no file exists. Writes a temp file and hard-links it
 * into place, so readers never see a half-written lease. Filesystems without
 * hard links fall back to an exclusive create.
 */
async function createLeaseExclusive(leasePath: string, content: string): Promise<boolean> {
  const tmpPath = `${leasePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tmp = await open(tmpPath, "wx");
  try {
    await tmp.writeFile(content);
    await tmp.sync();
  } finally {
    await tmp.close();
  }
  try {
    await link(tmpPath, leasePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return false;
    }
    if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EXDEV") {
      return createLeaseWithExclusiveOpen(leasePath, content);
    }
    throw error;
  } finally {
    await rm(tmpPath, { force: true });
  }
}

async function createLeaseWithExclusiveOpen(leasePath: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(leasePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

interface LeaseFileState {
  readonly raw: string;
  readonly mtimeMs: number;
  /** Undefined when the file exists but does not parse as a lease. */
  readonly snapshot: LeaseSnapshot | undefined;
}

async function readLeaseFileState(leasePath: string): Promise<LeaseFileState | undefined> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, mtimeMs] = await Promise.all([
      readFile(leasePath, "utf8"),
      stat(leasePath).then((stats) => stats.mtimeMs),
    ]);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  const info = parseLeaseInfo(raw);
  return { raw, mtimeMs, snapshot: info ? { info, mtimeMs } : undefined };
}
