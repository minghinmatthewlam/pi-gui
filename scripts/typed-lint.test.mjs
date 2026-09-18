import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));
// lintText replaces only the in-memory contents of existing project members.
// No invalid fixture is written into the checkout or its compiled output.
const paths = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/electron/main.ts",
  "apps/desktop/tests/core/smoke.spec.ts",
  "apps/desktop/scripts/capture-showcase.mts",
  "apps/website/app/page.tsx",
  "packages/catalogs/src/index.ts",
  "packages/pi-sdk-driver/src/index.ts",
  "packages/pi-sdk-driver/test/atomic-write.test.mts",
  "packages/session-driver/src/index.ts",
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
