import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";

// These are executable examples and format names, rather than untranslated prose.
const technicalCopy = new Set([
  "URL",
  "API",
  "OAuth",
  "docs",
  "npx",
  "ollama-local",
  "model-id",
  "http://localhost:11434/v1",
  "http://localhost:8000/v1",
  "https://example.com/mcp",
  "-y @modelcontextprotocol/server-filesystem .",
  "--api-key",
  "/v1",
  "~/.pi/agent/models.json",
  "/bin/zsh",
]);
const attributes = new Set([
  "title",
  "description",
  "label",
  "aria-label",
  "placeholder",
  "textareaPlaceholder",
  "textareaLabel",
  "body",
  "backLabel",
]);
const sourceRoot = resolve(__dirname, "../../src");
/**
 * Surfaces that are fully translated. A directory entry covers every `.tsx` file in
 * it, so a new Settings section is checked without anyone adding it here.
 */
const translatedSurfaces = [
  "features/settings",
  "app/secondary-surface.tsx",
  "app/secondary-surfaces.tsx",
];

async function surfaceFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  for (const surface of translatedSurfaces) {
    if (surface.endsWith(".tsx")) {
      files.push(surface);
      continue;
    }
    const entries = await readdir(resolve(sourceRoot, surface));
    files.push(
      ...entries.filter((name) => name.endsWith(".tsx")).map((name) => `${surface}/${name}`),
    );
  }
  return files;
}

test("translated surfaces cannot bypass the locale catalogs", async () => {
  const files = await surfaceFiles();
  expect(files).toContain("features/settings/settings-view.tsx");
  const untranslated: string[] = [];
  for (const file of files) {
    const source = await readFile(resolve(sourceRoot, file), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (node: ts.Node, text: string) => {
      const copy = text.replace(/\s+/g, " ").trim();
      if (!/[A-Za-z]{2}/.test(copy) || technicalCopy.has(copy)) return;
      untranslated.push(
        `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${copy}`,
      );
    };
    const expression = (node: ts.Expression) => {
      if (ts.isStringLiteralLike(node)) check(node, node.text);
      else if (ts.isTemplateExpression(node))
        check(node, node.head.text + node.templateSpans.map((span) => span.literal.text).join(" "));
      else if (ts.isConditionalExpression(node)) {
        expression(node.whenTrue);
        expression(node.whenFalse);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      )
        expression(node.right);
    };
    const walk = (node: ts.Node) => {
      if (ts.isJsxText(node)) check(node, node.text);
      if (ts.isJsxAttribute(node) && attributes.has(node.name.getText(tree)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) check(node.initializer, node.initializer.text);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression)
          expression(node.initializer.expression);
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  expect(
    untranslated,
    "User-facing strings must use the catalogs; add technical examples to the explicit allowlist",
  ).toEqual([]);
});
