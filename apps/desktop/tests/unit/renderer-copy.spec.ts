import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";
import { translatorFor } from "../../src/i18n/translate";
import { deriveModelOnboardingState } from "../../src/features/settings/model-onboarding";
import { builtinToolEntries } from "../../src/features/workbench/builtin-tools";
import {
  buildSlashCommandSections,
  thinkingOptions,
} from "../../src/features/conversation/composer-commands";

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
const surfaces = [
  "settings/settings-models-section.tsx",
  "settings/settings-providers-section.tsx",
  "settings/settings-custom-endpoints-section.tsx",
  "settings/settings-mcp-section.tsx",
  "extensions/customize-page.tsx",
  "extensions/skills-view.tsx",
  "extensions/extensions-view.tsx",
  "threads/new-thread-view.tsx",
  "conversation/composer-panel.tsx",
  "conversation/composer-surface.tsx",
];

test("settings, customization and new-thread copy cannot bypass the locale catalogs", async () => {
  const untranslated: string[] = [];
  for (const file of surfaces) {
    const source = await readFile(resolve(__dirname, "../../src/features", file), "utf8");
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

test("derived onboarding, workbench and slash-menu copy follows the selected language", () => {
  for (const [locale, noModels, files, model, low] of [
    ["zh-CN", "没有可用的模型", "文件", "模型", "低"],
    ["ja", "利用可能なモデルがありません", "ファイル", "モデル", "低"],
  ] as const) {
    const t = translatorFor(locale);
    const onboarding = deriveModelOnboardingState(
      undefined,
      { provider: undefined, modelId: undefined },
      t,
    );
    expect(onboarding.notice?.title).toBe(noModels);
    expect(onboarding.unselectedModelLabel).toBe(noModels);
    expect(onboarding.notice?.actionSection).toBe("providers");
    expect(builtinToolEntries(t).find((tool) => tool.kind === "files")?.label).toBe(files);
    expect(
      buildSlashCommandSections("/model", undefined, [], [], { t })
        .flatMap((section) => section.items)
        .find((command) => command.kind === "model")?.title,
    ).toBe(model);
    expect(thinkingOptions(t)[0]?.label).toBe(low);
  }
});
