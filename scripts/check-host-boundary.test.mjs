import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkHostBoundary } from "./check-host-boundary.mjs";

function fixture(host, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-gui-host-boundary-"));
  const files = {
    "apps/desktop/tsconfig.json": JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@renderer/*": ["src/*"] },
      },
    }),
    "apps/desktop/electron/main.ts": host,
    "apps/desktop/src/ui.ts": "export const value = 1; export type View = string;",
    "apps/desktop/contracts/types.ts": "export type Request = string;",
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return checkHostBoundary(root);
}

for (const source of [
  'import { value } from "../src/ui";',
  'import type { View } from "@renderer/ui";',
  'type View = import("../src/ui").View;',
  'void import("../src/ui");',
]) {
  test(`host rejects ${source}`, () => {
    assert.match(fixture(source)[0], /Host code cannot import renderer/);
  });
}

test("host rejects renderer dependency through a neutral-looking helper", () => {
  assert.equal(
    fixture('import "../contracts/helper";', {
      "apps/desktop/contracts/helper.ts": 'export * from "../src/ui";',
    }).length,
    1,
  );
});

test("host rejects test fixture dependencies", () => {
  assert.equal(
    fixture('import "../tests/fixture";', {
      "apps/desktop/tests/fixture.ts": "export const fixture = 1;",
    }).length,
    1,
  );
});

test("host accepts contracts and Node APIs", () => {
  assert.deepEqual(
    fixture('import fs from "node:fs"; import type { Request } from "../contracts/types";'),
    [],
  );
});

test("catalogs cannot import the Pi adapter even from an unused source file", () => {
  assert.match(
    fixture("export {};", {
      "packages/catalogs/src/store.ts": 'import "../../pi-sdk-driver/src/driver";',
      "packages/pi-sdk-driver/src/driver.ts": "export const driver = 1;",
    })[0],
    /Catalog storage cannot depend on the Pi adapter/,
  );
});

test("package source cannot reach the desktop host", () => {
  assert.match(
    fixture("export {};", {
      "packages/pi-sdk-driver/src/driver.ts": 'import "../../../apps/desktop/electron/main";',
    })[0],
    /Package source cannot depend on app implementation/,
  );
});
