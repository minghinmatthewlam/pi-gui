import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("source release/build directories remain format checked while outputs are ignored", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pi-gui-format-scope-"));
  copyFileSync(path.join(root, ".prettierignore"), path.join(fixture, ".prettierignore"));
  const source = ["apps/desktop/src/release-data/index.ts", "packages/catalogs/src/build/index.ts"];
  const generated = ["apps/desktop/release-candidate/index.ts", "packages/catalogs/dist/index.ts"];
  for (const relative of [...source, ...generated]) {
    const target = path.join(fixture, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export const value={bad:'format'}\n");
  }
  const run = (mode) =>
    spawnSync(
      process.execPath,
      [
        require.resolve("prettier/bin/prettier.cjs"),
        "--config",
        path.join(root, ".prettierrc.json"),
        mode,
        ".",
      ],
      { cwd: fixture, encoding: "utf8", timeout: 30_000 },
    );
  const failed = run("--check");
  assert.ifError(failed.error);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  for (const relative of source)
    assert.ok((failed.stdout + failed.stderr).includes(relative), relative);
  assert.equal(run("--write").status, 0);
  assert.equal(run("--check").status, 0);
  for (const relative of generated)
    assert.equal(
      readFileSync(path.join(fixture, relative), "utf8"),
      "export const value={bad:'format'}\n",
    );
});
