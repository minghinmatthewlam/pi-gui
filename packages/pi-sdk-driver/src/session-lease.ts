import { rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { writeJsonFileAtomic } from "./atomic-write.js";
import { isMissingFileError } from "./json-catalog-store.js";

/**
 * Advisory single-writer lease convention for pi session files.
 *
 * When pi-gui binds a live runtime to a session's JSONL, it drops a sibling
 * `<sessionFile>.lease` file recording who holds it. The lease is *advisory*:
 * the pi CLI knows nothing about it, so its presence must never block reading
 * or displaying a session, and its absence must be completely harmless. It only
 * lets one pi-gui runtime notice that another live writer (another GUI window,
 * or a future lease-aware CLI) is already appending to the same file, so it can
 * warn instead of blind-forking the conversation from a divergent leaf pointer.
 *
 * The suffix is `.lease`, chosen because pi's SessionManager discovers and
 * opens sessions strictly by `endsWith(".jsonl")` (verified in
 * node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js),
 * so a `.jsonl.lease` sibling is invisible to its listing and open logic.
 *
 * A lease is considered dead (and may be silently overwritten) when we can
 * prove the holder is gone: on the same host, when its pid is no longer alive;
 * on any host, when its file mtime is older than the TTL. Both checks are
 * conservative — a live holder is never treated as dead.
 */

export const LEASE_SUFFIX = ".lease";

/** A lease is stale after this long without its holder refreshing the mtime. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** Surface tag written into leases held by this app. */
export const PI_GUI_LEASE_SURFACE = "pi-gui";

export interface LeaseInfo {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly surface: string;
}

export interface LeaseSnapshot {
  readonly info: LeaseInfo;
  /** Modification time of the lease file, in epoch milliseconds. */
  readonly mtimeMs: number;
}

export interface LeaseIdentity {
  readonly pid: number;
  readonly hostname: string;
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
  return { pid: process.pid, hostname: hostname() };
}

export function isSameHolder(info: LeaseInfo | LeaseIdentity, self: LeaseIdentity): boolean {
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

export async function readLeaseSnapshot(leasePath: string): Promise<LeaseSnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(leasePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  let info: LeaseInfo;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseInfo>;
    if (
      typeof parsed?.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.surface !== "string"
    ) {
      return undefined;
    }
    info = {
      pid: parsed.pid,
      hostname: parsed.hostname,
      startedAt: parsed.startedAt,
      surface: parsed.surface,
    };
  } catch {
    // A corrupt lease is treated as absent: advisory data must never wedge us.
    return undefined;
  }

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(leasePath)).mtimeMs;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  return { info, mtimeMs };
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
  };
}
