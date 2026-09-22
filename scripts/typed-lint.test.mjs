import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));
// lintText replaces only the in-memory contents of existing project members.
// No invalid fixture is written into the checkout or its compiled output.
const paths = [
  "apps/desktop/src/app/App.tsx",
  "apps/desktop/electron/main.ts",
  "apps/desktop/tests/core/smoke.spec.ts",
  "apps/desktop/scripts/capture-showcase.mts",
  "apps/website/app/page.tsx",
  "packages/catalogs/src/index.ts",
  "packages/pi-sdk-driver/src/index.ts",
  "packages/catalogs/test/atomic-write.test.mts",
  "packages/pi-sdk-driver/test/session-schema.test.mts",
  "packages/session-driver/src/index.ts",
  "packages/extension-ui/src/index.ts",
  "video/src/Root.tsx",
];

test("each workspace and desktop execution context rejects unsafe values and unhandled promises", async () => {
  const eslint = new ESLint({
    cwd: root,
    // These repeated lintText calls replace project members in memory. CI's
    // single-run optimization otherwise reads their unchanged disk contents.
    // Keep every production rule/project; use the parser's editable program mode.
    overrideConfig: {
      languageOptions: {
        parserOptions: { disallowAutomaticSingleRunInference: true },
      },
    },
  });
  const invalid = `
    declare const unsafe: any;
    const copy = unsafe;
    unsafe.run();
    function consume(value: string) { return value; }
    consume(unsafe);
    function returnsString(): string { return unsafe; }
    async function save() { return 1; }
    save();
    void save();
    [1].forEach(async () => { await save(); });
  `;
  const expected = [
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-member-access",
    "no-unsafe-argument",
    "no-unsafe-return",
    "no-floating-promises",
    "no-misused-promises",
  ];
  for (const filePath of paths) {
    const [result] = await eslint.lintText(invalid, { filePath });
    for (const rule of expected) {
      assert(
        result.messages.some((message) => message.ruleId === `@typescript-eslint/${rule}`),
        `${filePath} must enforce ${rule}: ${JSON.stringify(result.messages)}`,
      );
    }
    assert.equal(
      result.messages.filter(
        (message) => message.ruleId === "@typescript-eslint/no-floating-promises",
      ).length,
      2,
      `${filePath}: bare void must not bypass promise handling`,
    );
    const [valid] = await eslint.lintText(
      `
      const input: unknown = JSON.parse('{"name":"Ada"}');
      function nameOf(value: unknown): string {
        if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") {
          throw new Error("Expected a name string");
        }
        return value.name;
      }
      async function save() { return nameOf(input); }
      save().catch((error: unknown) => { console.error("Save failed", error); });
      export async function run() { return await save(); }
    `,
      { filePath },
    );
    assert.equal(
      valid.errorCount + valid.warningCount,
      0,
      `${filePath}: ${JSON.stringify(valid.messages)}`,
    );
  }
});

const requiredTypedRules = [
  "no-floating-promises",
  "no-misused-promises",
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-call",
  "no-unsafe-member-access",
  "no-unsafe-return",
];

async function workspaceLintFailures(workspaceRoot) {
  const pnpmPath = process.env.npm_execpath ?? path.join(root, "node_modules/pnpm/bin/pnpm.cjs");
  const projects = JSON.parse(
    execFileSync(process.execPath, [pnpmPath, "-r", "list", "--depth", "-1", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }),
  ).filter((project) => realpathSync(project.path) !== realpathSync(workspaceRoot));
  assert.ok(projects.length, "No workspaces discovered; cannot prove typed lint coverage.");
  const eslint = new ESLint({ cwd: workspaceRoot });
  const failures = [];
  for (const project of projects) {
    const config = await eslint.calculateConfigForFile(
      path.join(project.path, "src/__lint_coverage__.ts"),
    );
    const missing = requiredTypedRules.filter(
      (name) => config?.rules?.[`@typescript-eslint/${name}`]?.[0] !== 2,
    );
    if (missing.length)
      failures.push(
        `${path.relative(workspaceRoot, project.path)}: add a typed project in eslint.config.mjs; missing ${missing.join(", ")}.`,
      );
  }
  return failures;
}

function lintFixture() {
  const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-gui-typed-lint-")));
  copyFileSync(path.join(root, "eslint.config.mjs"), path.join(fixture, "eslint.config.mjs"));
  symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "lint-fixture", private: true }),
  );
  writeFileSync(path.join(fixture, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  return fixture;
}

// Keep the explicit project list honest as pnpm discovers newly added workspaces.
// This runs through test:guards in the same pnpm check used by CI.
test("every discovered workspace has all required typed lint rules", async () => {
  assert.deepEqual(await workspaceLintFailures(root), []);
});

test("a new workspace cannot silently receive only syntax lint", async () => {
  const fixture = lintFixture();
  const workspace = path.join(fixture, "packages/new-feature");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "new-feature",
      scripts: { typecheck: "tsc --noEmit" },
    }),
  );
  assert.match(
    (await workspaceLintFailures(fixture)).join("\n"),
    /packages\/new-feature: add a typed project/,
  );
  // A concrete typed project registration restores the intended path.
  const registered = lintFixture();
  const registeredWorkspace = path.join(registered, "packages/new-feature");
  mkdirSync(registeredWorkspace, { recursive: true });
  copyFileSync(
    path.join(workspace, "package.json"),
    path.join(registeredWorkspace, "package.json"),
  );
  const { readFileSync } = await import("node:fs");
  const configPath = path.join(registered, "eslint.config.mjs");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      '...["catalogs", "pi-sdk-driver", "session-driver", "extension-ui"]',
      '...["catalogs", "pi-sdk-driver", "session-driver", "extension-ui", "new-feature"]',
    ),
  );
  mkdirSync(path.join(registeredWorkspace, "src"));
  const source = path.join(registeredWorkspace, "src/index.ts");
  writeFileSync(source, "async function save() { return 1; } save(); export {};\n");
  writeFileSync(
    path.join(registeredWorkspace, "tsconfig.lint.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  assert.deepEqual(await workspaceLintFailures(registered), []);
  const eslint = new ESLint({
    cwd: registered,
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const [invalid] = await eslint.lintFiles([source]);
  assert.ok(
    invalid.messages.some(
      (message) => message.ruleId === "@typescript-eslint/no-floating-promises",
    ),
    JSON.stringify(invalid.messages),
  );
  const [valid] = await eslint.lintText(
    "async function save() { return 1; } export async function run() { return await save(); }\n",
    { filePath: source },
  );
  assert.equal(valid.errorCount + valid.warningCount, 0, JSON.stringify(valid.messages));
});

test("source release/build directories are linted while generated output stays ignored", async () => {
  const fixture = lintFixture();
  const workspace = path.join(fixture, "packages/catalogs");
  mkdirSync(path.join(workspace, "src/release-data"), { recursive: true });
  mkdirSync(path.join(workspace, "src/build"), { recursive: true });
  writeFileSync(
    path.join(workspace, "tsconfig.lint.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  const files = ["src/release-data/index.ts", "src/build/index.ts"];
  for (const file of files)
    writeFileSync(
      path.join(workspace, file),
      "async function save() { return 1; } save(); export {};\n",
    );
  const eslint = new ESLint({ cwd: fixture });
  const results = await eslint.lintFiles(files.map((file) => path.join(workspace, file)));
  for (const result of results)
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "@typescript-eslint/no-floating-promises",
      ),
      JSON.stringify(result.messages),
    );
  for (const directory of ["dist", "release", "release-candidate", "out", "build"])
    assert.equal(await eslint.isPathIgnored(path.join(workspace, directory, "generated.ts")), true);
  for (const directory of [".worktrees", ".claude/worktrees", ".codex/worktrees"])
    assert.equal(
      await eslint.isPathIgnored(
        path.join(fixture, directory, "other-checkout/apps/desktop/out/generated.js"),
      ),
      true,
    );
});

test("compiler bypass comments fail but explained expected errors remain allowed", async () => {
  const eslint = new ESLint({ cwd: root });
  for (const comment of ["@ts-nocheck", "@ts-ignore", "@ts-expect-error"]) {
    const [result] = await eslint.lintText(`// ${comment}\nexport const value = 1;\n`, {
      filePath: "scripts/comment-fixture.ts",
    });
    assert.ok(
      result.messages.some((message) => message.ruleId === "@typescript-eslint/ban-ts-comment"),
      comment,
    );
  }
  const [valid] = await eslint.lintText(
    "// @ts-expect-error: Deliberately exercise invalid consumer input.\nexport const value: string = 1;\n",
    { filePath: "scripts/comment-fixture.ts" },
  );
  assert.equal(valid.errorCount + valid.warningCount, 0, JSON.stringify(valid.messages));
});
