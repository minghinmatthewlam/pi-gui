import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("format check rejects bad formatting and autofix is stable", () => {
  const fixture = path.join(mkdtempSync(path.join(os.tmpdir(), "pi-gui-format-")), "fixture.ts");
  writeFileSync(fixture, "export const config={timeout:5,label:'hello'}\n");
  const run = (mode) => {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("prettier/bin/prettier.cjs"),
        "--config",
        path.join(root, ".prettierrc.json"),
        mode,
        fixture,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.ifError(result.error);
    return result;
  };
  assert.equal(run("--check").status, 1);
  assert.equal(run("--write").status, 0);
  assert.equal(run("--check").status, 0);
  const formatted = readFileSync(fixture, "utf8");
  assert.equal(run("--write").status, 0);
  assert.equal(readFileSync(fixture, "utf8"), formatted);
});
