import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnLease,
  defaultIsPidAlive,
  isLeaseDead,
  isSameHolder,
  leaseBlocksBinding,
  readLeaseSnapshot,
  removeLeaseFile,
  sessionLeasePath,
  writeLeaseFile,
  type LeaseInfo,
  type LeaseSnapshot,
} from "../dist/session-lease.js";

const SELF = { pid: 4242, hostname: "self-host" };
const TTL = 60_000;

function foreignSnapshot(overrides: Partial<LeaseInfo> = {}, mtimeMs = 1_000): LeaseSnapshot {
  return {
    info: {
      pid: 9999,
      hostname: "other-host",
      startedAt: "2026-07-03T00:00:00.000Z",
      surface: "pi-gui",
      ...overrides,
    },
    mtimeMs,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lease-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("lease path is a .lease sibling of the session file (ignored by pi's .jsonl discovery)", () => {
  assert.equal(sessionLeasePath("/x/2026_abc.jsonl"), "/x/2026_abc.jsonl.lease");
  assert.ok(!sessionLeasePath("/x/2026_abc.jsonl").endsWith(".jsonl"));
});

await test("isSameHolder matches on pid + hostname only", () => {
  assert.ok(isSameHolder({ pid: 4242, hostname: "self-host" }, SELF));
  assert.ok(!isSameHolder({ pid: 4242, hostname: "other-host" }, SELF));
  assert.ok(!isSameHolder({ pid: 1, hostname: "self-host" }, SELF));
});

await test("same-host lease is dead when its pid is gone, alive when pid runs and mtime fresh", () => {
  const snap = foreignSnapshot({ hostname: "self-host" }, 10_000);
  const dead = isLeaseDead(snap, { now: 20_000, ttlMs: TTL, self: SELF, isPidAlive: () => false });
  const alive = isLeaseDead(snap, { now: 20_000, ttlMs: TTL, self: SELF, isPidAlive: () => true });
  assert.equal(dead, true);
  assert.equal(alive, false);
});

await test("cross-host lease falls back to TTL: fresh mtime alive, stale mtime dead", () => {
  const snap = foreignSnapshot({ hostname: "other-host" }, 10_000);
  // isPidAlive must never be consulted for a different host, so make it throw.
  const boom = () => {
    throw new Error("pid check must not run cross-host");
  };
  assert.equal(
    isLeaseDead(snap, { now: 10_000 + TTL - 1, ttlMs: TTL, self: SELF, isPidAlive: boom }),
    false,
  );
  assert.equal(
    isLeaseDead(snap, { now: 10_000 + TTL + 1, ttlMs: TTL, self: SELF, isPidAlive: boom }),
    true,
  );
});

await test("leaseBlocksBinding: own lease never blocks, foreign+alive blocks, foreign+dead does not", () => {
  const opts = { now: 20_000, ttlMs: TTL, self: SELF, isPidAlive: () => true };
  const own: LeaseSnapshot = { info: buildOwnLease(SELF, 19_000), mtimeMs: 19_000 };
  assert.equal(leaseBlocksBinding(own, opts), false);

  const foreignAlive = foreignSnapshot({ hostname: "other-host" }, 19_500);
  assert.equal(leaseBlocksBinding(foreignAlive, opts), true);

  const foreignDead = foreignSnapshot({ hostname: "other-host" }, 20_000 - TTL - 1);
  assert.equal(leaseBlocksBinding(foreignDead, opts), false);
});

await test("defaultIsPidAlive: current process alive, invalid pids not alive", () => {
  assert.equal(defaultIsPidAlive(process.pid), true);
  assert.equal(defaultIsPidAlive(0), false);
  assert.equal(defaultIsPidAlive(-1), false);
});

await test("write/read/remove lease round-trips and tolerates missing + corrupt files", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    assert.equal(await readLeaseSnapshot(leasePath), undefined, "missing lease reads as undefined");

    const info = buildOwnLease(SELF, Date.now());
    await writeLeaseFile(leasePath, info);
    const snap = await readLeaseSnapshot(leasePath);
    assert.ok(snap);
    assert.deepEqual(snap!.info, info);
    assert.equal(typeof snap!.mtimeMs, "number");

    await writeFile(leasePath, "{ not json", "utf8");
    assert.equal(await readLeaseSnapshot(leasePath), undefined, "corrupt lease reads as undefined");

    await removeLeaseFile(leasePath);
    assert.equal(await readLeaseSnapshot(leasePath), undefined);
    await removeLeaseFile(leasePath); // idempotent, no throw on missing
  });
});

await test("stale takeover: a dead foreign lease can be overwritten by our own", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    await writeLeaseFile(leasePath, {
      pid: 9999,
      hostname: "self-host",
      startedAt: "2026-01-01T00:00:00.000Z",
      surface: "pi-gui",
    });

    const stale = await readLeaseSnapshot(leasePath);
    assert.ok(stale);
    // Same host, pid reported dead → does not block, so we take over.
    const blocks = leaseBlocksBinding(stale!, {
      now: Date.now(),
      ttlMs: TTL,
      self: SELF,
      isPidAlive: () => false,
    });
    assert.equal(blocks, false);

    await writeLeaseFile(leasePath, buildOwnLease(SELF, Date.now()));
    const ours = await readLeaseSnapshot(leasePath);
    assert.equal(ours!.info.pid, SELF.pid);
    assert.equal(ours!.info.hostname, SELF.hostname);
  });
});
