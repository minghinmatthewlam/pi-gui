import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../dist/atomic-write.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-atomic-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("writes new content and creates missing directories", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "nested", "catalog.json");
    await writeFileAtomic(target, "hello");
    assert.equal(await readFile(target, "utf8"), "hello");
  });
});

await test("leaves only the target file behind, no lingering temp files", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "catalog.json");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["catalog.json"]);
    assert.equal(await readFile(target, "utf8"), "two");
  });
});

await test("concurrent writes never collide or leave a partial file; result is one of the inputs", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "catalog.json");
    const payloads = Array.from({ length: 40 }, (_, i) => `payload-${i}-${"x".repeat(i * 32)}`);

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    // A partial/truncated file would not exactly equal any input payload.
    const finalContent = await readFile(target, "utf8");
    assert.ok(payloads.includes(finalContent), "final content must be exactly one written payload");

    // Collision-safe temp names mean no *.tmp survivors from the racing writers.
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["catalog.json"]);
  });
});
