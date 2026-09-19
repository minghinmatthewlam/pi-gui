import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_SCHEMA_VERSION,
  buildSessionSchemaInfo,
  readSessionFileSchemaVersion,
  schemaVersionFromHeaderLine,
} from "../dist/session-schema.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-schema-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function headerLine(version: number | undefined): string {
  const header: Record<string, unknown> = {
    type: "session",
    id: "abc",
    cwd: "/x",
    timestamp: "2026-07-03T00:00:00Z",
  };
  if (version !== undefined) {
    header.version = version;
  }
  return `${JSON.stringify(header)}\n`;
}

await test("buildSessionSchemaInfo flags only strictly-newer file versions", () => {
  assert.equal(buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION).writtenByNewerRuntime, false);
  assert.equal(buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION + 1).writtenByNewerRuntime, true);
  assert.equal(buildSessionSchemaInfo(1).writtenByNewerRuntime, false);
  assert.equal(buildSessionSchemaInfo(undefined).writtenByNewerRuntime, false);

  const info = buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION + 2);
  assert.equal(info.fileSchemaVersion, RUNTIME_SCHEMA_VERSION + 2);
  assert.equal(info.runtimeSchemaVersion, RUNTIME_SCHEMA_VERSION);
});

await test("schemaVersionFromHeaderLine parses version, defaults missing to 1, rejects non-headers", () => {
  assert.equal(
    schemaVersionFromHeaderLine(JSON.stringify({ type: "session", id: "a", version: 4 })),
    4,
  );
  assert.equal(schemaVersionFromHeaderLine(JSON.stringify({ type: "session", id: "a" })), 1);
  assert.equal(
    schemaVersionFromHeaderLine(JSON.stringify({ type: "message", role: "user" })),
    undefined,
  );
  assert.equal(schemaVersionFromHeaderLine("{ not json"), undefined);
});

await test("current-version file is not flagged as written by a newer runtime", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      headerLine(RUNTIME_SCHEMA_VERSION) + '{"type":"message","role":"user"}\n',
    );
    const version = await readSessionFileSchemaVersion(file);
    assert.equal(version, RUNTIME_SCHEMA_VERSION);
    assert.equal(buildSessionSchemaInfo(version).writtenByNewerRuntime, false);
  });
});

await test("a file written by a newer pi is flagged", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      headerLine(RUNTIME_SCHEMA_VERSION + 1) + '{"type":"message","role":"user"}\n',
    );
    const version = await readSessionFileSchemaVersion(file);
    assert.equal(version, RUNTIME_SCHEMA_VERSION + 1);
    assert.equal(buildSessionSchemaInfo(version).writtenByNewerRuntime, true);
  });
});

await test("the detected version survives external appends (disk-tail re-read)", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      headerLine(RUNTIME_SCHEMA_VERSION + 1) + '{"type":"message","role":"user"}\n',
    );
    assert.equal(await readSessionFileSchemaVersion(file), RUNTIME_SCHEMA_VERSION + 1);

    // Simulate an external CLI turn appended after we first read — the header
    // (and thus the skew flag) is unchanged.
    await appendFile(file, '{"type":"message","role":"assistant"}\n');
    assert.equal(await readSessionFileSchemaVersion(file), RUNTIME_SCHEMA_VERSION + 1);
  });
});

await test("unreadable / headerless files yield undefined (skew assumed absent)", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readSessionFileSchemaVersion(join(dir, "missing.jsonl")), undefined);

    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "");
    assert.equal(await readSessionFileSchemaVersion(empty), undefined);

    const noHeader = join(dir, "nohdr.jsonl");
    await writeFile(noHeader, '{"type":"message","role":"user"}\n');
    assert.equal(await readSessionFileSchemaVersion(noHeader), undefined);
  });
});
