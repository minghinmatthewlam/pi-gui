import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRendererBoundary } from "./check-renderer-boundary.mjs";

function fixture(source, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-gui-boundary-"));
  const files = {
    "apps/desktop/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@main/*": ["electron/*"], "@shared/*": ["../../packages/shared/*"] },
      },
      include: ["src"],
    }),
    "apps/desktop/src/index.ts": source,
    "apps/desktop/electron/service.ts": "export const service = 1; export type Contract = string;",
    "packages/shared/pure.ts": "export const value = 1; export type Contract = string;",
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return checkRendererBoundary(root);
}

for (const source of [
  'import fs from "node:fs";',
  'import "fs/promises";',
  'import { ipcRenderer } from "electron";',
  'import "@earendil-works/pi-coding-agent";',
  'import "@earendil-works/pi-agent-core";',
  'import "../electron/service.js";',
  'import "@main/service";',
  'export * from "@main/service";',
  'import { type Contract, service } from "@main/service";',
  'void import("@main/service");',
  'require("@main/service");',
  'import service = require("@main/service");',
  'const target = "@main/service"; void import(target);',
  'import "./missing.js";',
  'import.meta.glob("../electron/*.ts", { eager: true });',
]) {
  test(`rejects ${source}`, () => {
    const result = fixture(source);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /src\/index.ts:1:/);
  });
}

test("follows aliased workspace re-exports and .js source resolution", () => {
  const result = fixture('import { value } from "@shared/barrel";', {
    "packages/shared/barrel.ts": 'export { value } from "./runtime.js";',
    "packages/shared/runtime.ts": 'import "node:fs"; export const value = 1;',
  });
  assert.equal(result.checkedFiles, 3);
  assert.match(result.failures.join("\n"), /packages\/shared\/runtime.ts:1: Forbidden/);
});

test("allows explicit type-only imports, pure helpers, cycles and browser assets", () => {
  const result = fixture(
    `
    import type { Contract } from "@main/service";
    import { type Contract as Other } from "@main/service";
    export type { Contract } from "@main/service";
    export { type Contract as Another } from "@main/service";
    import { value } from "@shared/pure";
    import "./cycle.js";
    import "./style.css";
  `,
    { "apps/desktop/src/cycle.ts": 'import "./index.js";' },
  );
  assert.deepEqual(result.failures, []);
  assert.equal(result.checkedFiles, 3);
});

test("rejects runtime imports backed only by local declarations", () => {
  const result = fixture('import { value } from "@shared/declarations";', {
    "packages/shared/declarations.d.ts": "export declare const value: number;",
  });
  assert.match(result.failures.join("\n"), /resolves only to local declarations/);
});

test("checks resolved package identity even behind an npm alias", () => {
  const result = fixture('import "disguised-runtime";', {
    "node_modules/disguised-runtime/package.json": JSON.stringify({
      name: "electron",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "node_modules/disguised-runtime/index.d.ts": "export declare const value: number;",
  });
  assert.match(result.failures.join("\n"), /Forbidden runtime package 'electron'/);
});

test("allows ordinary external browser packages", () => {
  const result = fixture('import "browser-library";', {
    "node_modules/browser-library/package.json": JSON.stringify({
      name: "browser-library",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "node_modules/browser-library/index.d.ts": "export declare const value: number;",
  });
  assert.deepEqual(result.failures, []);
});
