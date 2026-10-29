#!/usr/bin/env node
/*
 * Scaffolds a new language for the desktop app, and reports how much of one is
 * still English.
 *
 *   node scripts/new-locale.mjs <tag> <label>    e.g. `fr "Français"`
 *   node scripts/new-locale.mjs --check [tag]    lists the copy left to translate
 *
 * Every non-English catalog is a `Partial<Messages>`: a key it leaves out renders
 * the English copy. The generated catalog starts as English copy, as a template
 * for the translator. `--check` is a report, not a gate: it always exits 0, so a
 * missing translation never fails CI.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18nDirectory = path.join(repoRoot, "apps", "desktop", "src", "i18n");
const catalogPath = path.join(i18nDirectory, "catalog.ts");
const englishPath = path.join(i18nDirectory, "messages", "en.ts");

/** The shape `tests/unit/i18n.spec.ts` accepts: a primary subtag, then optional subtags. */
const TAG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const PLURAL_VARIANT = /_(zero|one|two|few|many|other)$/;

const USAGE = "Usage: node scripts/new-locale.mjs <tag> <label> | --check [tag]";

function fail(message) {
  console.error(`${message}\n`);
  console.error(USAGE);
  process.exitCode = 1;
}

/**
 * The `"key": "value"` pairs of a catalog module, ignoring comments and the
 * wrapper. Prettier wraps long entries onto a second line, so the value may sit
 * after a newline — read the file as a whole rather than line by line.
 */
const ENTRY_PATTERN =
  /^ {2}"((?:[^"\\]|\\.)*)":\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'),?$/gm;

function readEntries(source) {
  const entries = [];
  for (const match of source.matchAll(ENTRY_PATTERN)) {
    // Prettier single-quotes a value that contains a double quote.
    entries.push({ key: match[1], copy: match[2] ?? match[3], text: match[0] });
  }
  return entries;
}

/** Catalogs are emitted in the source's own layout, so the copy stays Prettier-clean. */
function asObjectEntries(entries) {
  return entries
    .map((entry) => (entry.text.endsWith(",") ? entry.text : `${entry.text},`))
    .join("\n");
}

/** "zh-CN" → "zhCN", "pt-BR" → "ptBR": the catalog import name follows the tag. */
function variableName(tag) {
  const [primary, ...subtags] = tag.split("-");
  return (
    primary.toLowerCase() +
    subtags.map((subtag) => subtag.charAt(0).toUpperCase() + subtag.slice(1)).join("")
  );
}

function reportUntranslated(tag) {
  const messagesPath = path.join(i18nDirectory, "messages", `${tag}.ts`);
  if (!existsSync(messagesPath)) {
    fail(`No catalog for "${tag}" at ${messagesPath}.`);
    return;
  }
  const english = readEntries(readFileSync(englishPath, "utf8"));
  const translated = new Map(
    readEntries(readFileSync(messagesPath, "utf8")).map((entry) => [entry.key, entry.copy]),
  );
  // Plural variants (`key_one`, …) are optional per language, since the plain key
  // covers every count. A variant still holding English copy is reported, though:
  // at runtime it wins over the translated plain key.
  const plainKeys = english.filter((entry) => !PLURAL_VARIANT.test(entry.key));
  const missing = plainKeys.filter((entry) => !translated.has(entry.key));
  const untouched = english.filter((entry) => translated.get(entry.key) === entry.copy);
  const pending = missing.length + untouched.length;
  if (pending === 0) {
    console.log(`${tag}: every key is translated.`);
    return;
  }
  console.log(`${tag}: ${pending} keys still read English:`);
  for (const entry of missing) {
    console.log(`  ${entry.key}  (missing)  ←  ${entry.copy}`);
  }
  for (const entry of untouched) {
    console.log(`  ${entry.key}  ←  ${entry.copy}`);
  }
}

/** Every catalog other than English, by tag. */
function registeredTags() {
  return readdirSync(path.join(i18nDirectory, "messages"))
    .filter((name) => name.endsWith(".ts") && name !== "en.ts")
    .map((name) => name.slice(0, -".ts".length))
    .sort();
}

function createLocale(tag, label) {
  if (!TAG_PATTERN.test(tag)) {
    fail(`"${tag}" is not a language tag this registry accepts, e.g. "fr" or "zh-Hant".`);
    return;
  }
  if (!label.trim()) {
    fail('A label is required, written in the language itself, e.g. "Français".');
    return;
  }

  const messagesPath = path.join(i18nDirectory, "messages", `${tag}.ts`);
  if (existsSync(messagesPath)) {
    fail(`${messagesPath} already exists; translate it instead of scaffolding again.`);
    return;
  }

  const catalog = readFileSync(catalogPath, "utf8");
  if (catalog.includes(`id: "${tag}"`)) {
    fail(`"${tag}" is already registered in catalog.ts.`);
    return;
  }

  const english = readEntries(readFileSync(englishPath, "utf8"));
  if (english.length === 0) {
    fail(`Could not read any messages from ${englishPath}.`);
    return;
  }

  const name = variableName(tag);
  // Plural variants are left out: the plain key covers every count until the
  // translator adds the forms the language uses, and a copied English variant would
  // win over a translated plain key.
  const entries = asObjectEntries(english.filter((entry) => !PLURAL_VARIANT.test(entry.key)));
  const importLine = `import { ${name} } from "./messages/${tag}";`;
  const lastImport = /^import .* from "\.\/messages\/[^"]+";$/m;
  const importMatches = [...catalog.matchAll(new RegExp(lastImport, "gm"))];
  if (importMatches.length === 0) {
    fail(`Could not find a ./messages/ import in ${catalogPath}.`);
    return;
  }
  const last = importMatches[importMatches.length - 1];
  const afterImports =
    catalog.slice(0, last.index + last[0].length) +
    `\n${importLine}` +
    catalog.slice(last.index + last[0].length);

  const registryEnd = "\n] as const satisfies readonly LocaleDefinition[];";
  if (!afterImports.includes(registryEnd)) {
    fail(`Could not find the LOCALES array in ${catalogPath}.`);
    return;
  }
  const entry = [
    "  {",
    `    id: "${tag}",`,
    `    label: ${JSON.stringify(label)},`,
    `    messages: ${name},`,
    `    matchesSystemTag: (languageTag) => languageTagParts(languageTag).primary === "${tag.split("-")[0]}",`,
    "  },",
  ].join("\n");
  // Both edits are checked before either file is written, so a failure leaves nothing behind.
  writeFileSync(
    messagesPath,
    `import type { Messages } from "./en";

/*
 * ${label} copy, scaffolded from English as a template. Replace each value, and
 * delete entries you do not translate: a missing key renders the English copy.
 * \`pnpm i18n:check ${tag}\` lists what still reads English.
 */
export const ${name}: Partial<Messages> = {
${entries}
};
`,
  );

  writeFileSync(catalogPath, afterImports.replace(registryEnd, `\n${entry}${registryEnd}`));

  console.log(`Created ${messagesPath}`);
  console.log(`Registered "${tag}" in catalog.ts.`);
  console.log("");
  console.log(`Next: translate the values, then \`pnpm i18n:check ${tag}\`.`);
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  if (args.length > 2) {
    fail("--check takes at most one tag.");
  } else {
    for (const tag of args.length === 2 ? [args[1]] : registeredTags()) {
      reportUntranslated(tag);
    }
  }
} else if (args.length >= 2) {
  createLocale(args[0], args.slice(1).join(" "));
} else {
  fail("A tag and a label are required.");
}
