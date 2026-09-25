import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLeaseFile,
  buildOwnLease,
  defaultIsPidAlive,
  isLeaseDead,
  isSameHolder,
  leaseBlocksBinding,
  readLeaseSnapshot,
  refreshLeaseFile,
  releaseLeaseFile,
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

await test("isSameHolder matches on pid + hostname for tokenless leases", () => {
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

const SELF_TOKENED = { pid: 4242, hostname: "self-host", token: "token-a" };

function stalenessFor(self: typeof SELF_TOKENED, now: number, isPidAlive = () => true) {
  return { now, ttlMs: TTL, self, isPidAlive };
}

await test("isSameHolder compares owner tokens when both sides have one", () => {
  assert.ok(isSameHolder(buildOwnLease(SELF_TOKENED, 0), SELF_TOKENED));
  // Same pid + host but a different token is a different process (pid reuse).
  assert.ok(!isSameHolder({ ...SELF_TOKENED, token: "token-b" }, SELF_TOKENED));
  // Leases written before tokens existed still match on pid + host.
  assert.ok(isSameHolder({ pid: 4242, hostname: "self-host" }, SELF_TOKENED));
});

await test("acquireLeaseFile: absent → acquired, own → acquired, live foreign → held", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    const now = Date.now();
    assert.deepEqual(await acquireLeaseFile(leasePath, stalenessFor(SELF_TOKENED, now)), {
      status: "acquired",
    });
    assert.equal((await readLeaseSnapshot(leasePath))!.info.token, "token-a");
    assert.deepEqual(await acquireLeaseFile(leasePath, stalenessFor(SELF_TOKENED, now)), {
      status: "acquired",
    });

    const other = { pid: 4242, hostname: "self-host", token: "token-b" };
    const result = await acquireLeaseFile(leasePath, stalenessFor(other, now));
    assert.equal(result.status, "held");
    assert.equal(result.status === "held" && result.holder.token, "token-a");
    assert.equal((await readLeaseSnapshot(leasePath))!.info.token, "token-a", "holder untouched");
  });
});

await test("acquireLeaseFile takes over dead and corrupt leases", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    await writeLeaseFile(leasePath, {
      pid: 9999,
      hostname: "self-host",
      startedAt: "2026-01-01T00:00:00.000Z",
      surface: "pi-gui",
    });
    const result = await acquireLeaseFile(
      leasePath,
      stalenessFor(SELF_TOKENED, Date.now(), () => false),
    );
    assert.equal(result.status, "acquired");
    assert.equal((await readLeaseSnapshot(leasePath))!.info.token, "token-a");

    // An unparseable lease is abandoned once it is older than the settle window.
    await writeFile(leasePath, "{ not json", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(leasePath, old, old);
    assert.equal(
      (await acquireLeaseFile(leasePath, stalenessFor(SELF_TOKENED, Date.now()))).status,
      "acquired",
    );
    assert.equal((await readLeaseSnapshot(leasePath))!.info.token, "token-a");
  });
});

await test("a refreshed lease keeps blocking past two TTLs; an unrefreshed one expires", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    const t0 = Date.now();
    const holder = { pid: 1111, hostname: "host-a", token: "holder" };
    const taker = { pid: 2222, hostname: "host-b", token: "taker" };
    assert.equal((await acquireLeaseFile(leasePath, stalenessFor(holder, t0))).status, "acquired");

    // Heartbeats at 0.9 TTL and 1.8 TTL keep the lease alive at 2 TTL.
    assert.equal(await refreshLeaseFile(leasePath, holder, t0 + TTL * 0.9), "refreshed");
    assert.equal(await refreshLeaseFile(leasePath, holder, t0 + TTL * 1.8), "refreshed");
    assert.equal(
      (await acquireLeaseFile(leasePath, stalenessFor(taker, t0 + TTL * 2))).status,
      "held",
    );

    // Without further heartbeats it is dead one TTL after the last refresh.
    assert.equal(
      (await acquireLeaseFile(leasePath, stalenessFor(taker, t0 + TTL * 2.9))).status,
      "acquired",
    );
    assert.equal(await refreshLeaseFile(leasePath, holder, t0 + TTL * 3), "lost");
  });
});

await test("releaseLeaseFile removes only the caller's own lease", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    const other = { pid: 4242, hostname: "self-host", token: "token-b" };
    await acquireLeaseFile(leasePath, stalenessFor(other, Date.now()));

    await releaseLeaseFile(leasePath, SELF_TOKENED);
    assert.equal((await readLeaseSnapshot(leasePath))!.info.token, "token-b");

    await releaseLeaseFile(leasePath, other);
    assert.equal(await readLeaseSnapshot(leasePath), undefined);
    await releaseLeaseFile(leasePath, other); // missing lease is fine
  });
});

async function raceForLease(leasePath: string, processes: number): Promise<string[]> {
  const startAt = Date.now() + 1_000;
  const leaseModule = new URL("../dist/session-lease.js", import.meta.url).href;
  // Each child waits for a shared start time, races, prints its result, then
  // stays alive (so its lease is live) until the parent closes stdin.
  const script = `
    const { acquireLeaseFile, currentLeaseIdentity, defaultIsPidAlive } = await import(${JSON.stringify(leaseModule)});
    if (Date.now() > ${startAt}) { process.stdout.write("late\\n"); }
    while (Date.now() < ${startAt}) {}
    const result = await acquireLeaseFile(${JSON.stringify(leasePath)}, {
      now: Date.now(), ttlMs: 60000, self: currentLeaseIdentity(), isPidAlive: defaultIsPidAlive,
    });
    process.stdout.write(result.status + "\\n");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `;
  const children = Array.from({ length: processes }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
  try {
    return await Promise.all(
      children.map(
        (child) =>
          new Promise<string>((resolve, reject) => {
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString();
              const lines = out.split("\n").filter(Boolean);
              if (lines.includes("late")) reject(new Error("child started after the race"));
              if (lines.length > 0) resolve(lines[0]!);
            });
            child.on("exit", (code) => reject(new Error(`child exited early (${code})`)));
          }),
      ),
    );
  } finally {
    const running = children.filter((child) => child.exitCode === null);
    for (const child of running) {
      child.stdin.end();
    }
    await Promise.all(running.map((child) => once(child, "exit")));
  }
}

await test("processes racing for an absent session lease: exactly one acquires", async () => {
  await withTempDir(async (dir) => {
    const statuses = await raceForLease(join(dir, "session.jsonl.lease"), 6);
    assert.equal(statuses.filter((status) => status === "acquired").length, 1, statuses.join());
    assert.equal(statuses.filter((status) => status === "held").length, 5, statuses.join());
  });
});

await test("processes racing to take over a dead lease: exactly one acquires", async () => {
  for (let round = 0; round < 5; round += 1) {
    await withTempDir(async (dir) => {
      const leasePath = join(dir, "session.jsonl.lease");
      // A lease left by a process on this host that no longer runs.
      await writeLeaseFile(leasePath, {
        pid: 2 ** 22 + 7,
        hostname: hostname(),
        startedAt: "2026-01-01T00:00:00.000Z",
        surface: "pi-gui",
        token: "crashed",
      });
      const statuses = await raceForLease(leasePath, 6);
      assert.equal(statuses.filter((status) => status === "acquired").length, 1, statuses.join());
      assert.notEqual((await readLeaseSnapshot(leasePath))!.info.token, "crashed");
    });
  }
});

await test("releaseLeaseFile waits for an in-progress takeover before checking ownership", async () => {
  await withTempDir(async (dir) => {
    const leasePath = join(dir, "session.jsonl.lease");
    await acquireLeaseFile(leasePath, stalenessFor(SELF_TOKENED, Date.now()));
    // Another process holds the takeover guard.
    await writeFile(`${leasePath}.takeover`, "999\n", "utf8");

    let released = false;
    const release = releaseLeaseFile(leasePath, SELF_TOKENED).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(released, false, "release must wait for the guard");
    assert.ok(await readLeaseSnapshot(leasePath));

    await rm(`${leasePath}.takeover`);
    await release;
    assert.equal(await readLeaseSnapshot(leasePath), undefined);
  });
});
