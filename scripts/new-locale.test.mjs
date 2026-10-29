import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./new-locale.mjs", import.meta.url));

// `a.wrapped` mirrors the entries Prettier breaks onto a second line in the real
// catalogs, and `c.last` the entry that carries no trailing comma. Both have bitten
// this script before, so the fixture keeps them.
const ENGLISH_SOURCE = `export const en = {
  "a.simple": "Simple",
  "b.wrapped":
    "A value Prettier wrapped onto its own line",
  "c.last": "Last"
} as const;
`;

// Just enough registry for the script's anchors: a ./messages/ import and the
// LOCALES array it appends to.
const CATALOG_SOURCE = `import { en } from "./messages/en";

export const LOCALES = [
] as const satisfies readonly LocaleDefinition[];
`;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-gui-new-locale-"));
  const i18n = path.join(root, "apps", "desktop", "src", "i18n");
  mkdirSync(path.join(i18n, "messages"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(script, path.join(root, "scripts", "new-locale.mjs"));
  writeFileSync(path.join(i18n, "messages", "en.ts"), ENGLISH_SOURCE);
  writeFileSync(path.join(i18n, "catalog.ts"), CATALOG_SOURCE);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "new-locale.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

const catalogOf = (root) =>
  readFileSync(path.join(root, "apps/desktop/src/i18n/catalog.ts"), "utf8");
const localeOf = (root, tag) =>
  readFileSync(path.join(root, "apps/desktop/src/i18n/messages", `${tag}.ts`), "utf8");

function scaffold(t) {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("scaffolds a catalog covering every English key, wrapped entries included", (t) => {
  const root = scaffold(t);
  const result = run(root, "fr", "Français");
  assert.equal(result.status, 0, result.stderr);

  const locale = localeOf(root, "fr");
  assert.match(locale, /export const fr: Partial<Messages> = \{/);
  assert.match(locale, /  "a\.simple": "Simple",/);
  assert.match(locale, /  "c\.last": "Last",/);
  // The layout is copied from the English source, so the scaffolded file is already
  // Prettier-clean and `pnpm check` passes before a single word is translated.
  assert.match(locale, /  "b\.wrapped":\n    "A value Prettier wrapped onto its own line",/);
});

test("registers the locale in the catalog", (t) => {
  const root = scaffold(t);
  assert.equal(run(root, "pt-BR", "Português (Brasil)").status, 0);

  const catalog = catalogOf(root);
  assert.match(catalog, /^import \{ ptBR \} from "\.\/messages\/pt-BR";$/m);
  assert.match(
    catalog,
    /    id: "pt-BR",\n    label: "Português \(Brasil\)",\n    messages: ptBR,\n    matchesSystemTag/,
  );
  assert.match(catalog, /primary === "pt",/);
});

test("refuses a tag that is already registered or malformed", (t) => {
  const root = scaffold(t);
  assert.equal(run(root, "fr", "Français").status, 0);

  const duplicate = run(root, "fr", "Français");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);

  const malformed = run(root, "French!", "Français");
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /not a language tag/);

  const unlabelled = run(root, "de");
  assert.equal(unlabelled.status, 1);
  assert.match(unlabelled.stderr, /Usage:/);
});

test("--check reports what still reads English, and shrinks as it is translated", (t) => {
  const root = scaffold(t);
  assert.equal(run(root, "fr", "Français").status, 0);
  assert.match(run(root, "--check", "fr").stdout, /fr: 3 keys still read English:/);

  const localePath = path.join(root, "apps/desktop/src/i18n/messages/fr.ts");
  writeFileSync(
    localePath,
    localeOf(root, "fr").replace('"a.simple": "Simple"', '"a.simple": "Simple (fr)"'),
  );
  assert.match(run(root, "--check", "fr").stdout, /fr: 2 keys still read English:/);

  writeFileSync(
    localePath,
    localeOf(root, "fr")
      .replace(
        '"b.wrapped":\n    "A value Prettier wrapped onto its own line"',
        '"b.wrapped": "Valeur"',
      )
      .replace('"c.last": "Last"', '"c.last": "Dernier"'),
  );
  assert.match(run(root, "--check", "fr").stdout, /every key is translated/);
});

test("--check counts missing keys, reports every catalog without a tag, and never fails", (t) => {
  const root = scaffold(t);
  assert.equal(run(root, "fr", "Français").status, 0);
  assert.equal(run(root, "de", "Deutsch").status, 0);

  const localePath = path.join(root, "apps/desktop/src/i18n/messages/fr.ts");
  writeFileSync(
    localePath,
    localeOf(root, "fr")
      .replace('  "a.simple": "Simple",\n', "")
      .replace('"c.last": "Last"', '"c.last": "Dernier"'),
  );
  const fr = run(root, "--check", "fr");
  assert.equal(fr.status, 0);
  assert.match(fr.stdout, /fr: 2 keys still read English:/);
  assert.match(fr.stdout, /a\.simple {2}\(missing\)/);

  const all = run(root, "--check");
  assert.equal(all.status, 0);
  assert.match(all.stdout, /de: 3 keys still read English:/);
  assert.match(all.stdout, /fr: 2 keys still read English:/);
});

test("scaffolding leaves plural variants out, reads single-quoted copy, and --check flags English variants", (t) => {
  const root = scaffold(t);
  // Prettier single-quotes a value that contains a double quote.
  writeFileSync(
    path.join(root, "apps/desktop/src/i18n/messages/en.ts"),
    `export const en = {
  "a.quoted": 'Remove "{name}"?',
  "b.count": "{count} things",
  "b.count_one": "{count} thing",
  "b.count_other": "{count} things",
} as const;
`,
  );
  assert.equal(run(root, "ja", '日本語 "JP"').status, 0);
  const locale = localeOf(root, "ja");
  assert.match(locale, / {2}"a\.quoted": 'Remove "\{name\}"\?',/);
  assert.match(locale, / {2}"b\.count": "\{count\} things",/);
  assert.doesNotMatch(locale, /b\.count_/);
  // The label is written as a string literal, so quotes in it cannot break catalog.ts.
  assert.match(catalogOf(root), / {4}label: "日本語 \\"JP\\"",/);
  assert.match(run(root, "--check", "ja").stdout, /ja: 2 keys still read English:/);

  const localePath = path.join(root, "apps/desktop/src/i18n/messages/ja.ts");
  writeFileSync(
    localePath,
    localeOf(root, "ja")
      .replace(`'Remove "{name}"?'`, `'"{name}" を削除しますか？'`)
      .replace(
        '"b.count": "{count} things",',
        '"b.count": "{count} 個",\n  "b.count_other": "{count} things",',
      ),
  );
  const check = run(root, "--check", "ja").stdout;
  assert.match(check, /ja: 1 keys still read English:/);
  assert.match(check, /b\.count_other {2}←/);
});
