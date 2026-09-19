import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PRIVATE_PI_HOOKS = new Set([
  "_rewriteFile",
  "flushed",
  "markProjectModified",
  "saveProjectSettings",
]);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");

function findPrivatePiHookAccesses(fileName: string, text: string): string[] {
  const normalizedFile = fileName.replaceAll(path.sep, "/");
  if (normalizedFile.includes("/src/compat/")) {
    return [];
  }

  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];

  function record(node: ts.Node, hook: string): void {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    failures.push(`${fileName}:${line + 1}:${character + 1}: private Pi hook ${hook}`);
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && PRIVATE_PI_HOOKS.has(node.name.text)) {
      record(node.name, node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      PRIVATE_PI_HOOKS.has(node.argumentExpression.text)
    ) {
      record(node.argumentExpression, node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return failures;
}

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFilesUnder(fullPath);
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

await test("private Pi hooks stay behind the compatibility boundary", () => {
  const failures = sourceFilesUnder(sourceRoot).flatMap((file) =>
    findPrivatePiHookAccesses(file, readFileSync(file, "utf8")),
  );
  assert.deepEqual(failures, []);
});

await test("private Pi hook guard rejects direct property and element access", () => {
  const failures = findPrivatePiHookAccesses(
    "/repo/packages/pi-sdk-driver/src/session.ts",
    `
manager._rewriteFile?.();
manager["flushed"] = true;
settings.markProjectModified("defaultModel");
settings[\`saveProjectSettings\`]({});
`,
  );

  assert.deepEqual(
    failures.map((failure) => failure.match(/private Pi hook (\w+)/)?.[1]),
    ["_rewriteFile", "flushed", "markProjectModified", "saveProjectSettings"],
  );
});

await test("private Pi hook guard accepts adapter access and ignores comments and strings", () => {
  assert.deepEqual(
    findPrivatePiHookAccesses(
      "/repo/packages/pi-sdk-driver/src/compat/pi-session.ts",
      "manager._rewriteFile(); manager.flushed = true;",
    ),
    [],
  );
  assert.deepEqual(
    findPrivatePiHookAccesses(
      "/repo/packages/pi-sdk-driver/src/session.ts",
      '// manager._rewriteFile();\nconst documentation = "manager.flushed";',
    ),
    [],
  );
});
