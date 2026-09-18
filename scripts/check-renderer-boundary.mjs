import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const runtimePackages = new Set([
  "electron",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
]);
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const isInside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
const packageName = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

export function checkRendererBoundary(root) {
  root = realpathSync(root);
  const renderer = path.join(root, "apps/desktop/src");
  const main = path.join(root, "apps/desktop/electron");
  const configPath = path.join(root, "apps/desktop/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length)
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  const pending = ts.sys
    .readDirectory(renderer, sourceExtensions)
    .filter((file) => !/\.d\.[cm]?ts$/.test(file));
  if (!pending.length) throw new Error("Renderer boundary check found no source files.");
  const visited = new Set();
  const failures = [];
  const cache = ts.createModuleResolutionCache(root, (file) => file, parsed.options);

  while (pending.length) {
    const file = realpathSync(pending.pop());
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    // Vite ?worker imports already expose a constructor whose entry is checked
    // through the import declaration; calling it takes no module URL.
    const importedWorkerConstructors = new Set(
      source.statements
        .filter(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            /[?&](?:worker|sharedworker)(?:&|$)/.test(node.moduleSpecifier.text),
        )
        .map((node) => node.importClause?.name?.text)
        .filter(Boolean),
    );
    const fail = (node, reason) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${path.relative(root, file)}:${line + 1}: ${reason}`);
    };
    const inspect = (expression, repair = "Use the preload API instead.") => {
      if (!expression || !ts.isStringLiteralLike(expression)) {
        fail(
          expression ?? source,
          "Computed module loading cannot be checked; use a literal import.",
        );
        return;
      }
      const specifier = expression.text.split(/[?#]/, 1)[0];
      if (
        isBuiltin(specifier) ||
        specifier.startsWith("node:") ||
        runtimePackages.has(packageName(specifier))
      ) {
        fail(expression, `Forbidden renderer runtime dependency '${specifier}'. ${repair}`);
        return;
      }
      // Vite asset imports contain no JavaScript runtime dependency.
      if (/\.(css|svg|png|jpe?g|gif|webp|woff2?|ttf)$/.test(specifier)) return;
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!resolved) {
        fail(
          expression,
          `Cannot resolve '${specifier}'; the renderer dependency graph must be checkable.`,
        );
        return;
      }
      if (runtimePackages.has(resolved.packageId?.name)) {
        fail(
          expression,
          `Forbidden runtime package '${resolved.packageId.name}' through '${specifier}'. ${repair}`,
        );
        return;
      }
      const target = realpathSync(resolved.resolvedFileName);
      if (isInside(main, target)) {
        fail(
          expression,
          `Renderer reaches main/preload implementation '${path.relative(root, target)}'. ${repair}`,
        );
      } else if (isInside(root, target) && !target.includes(`${path.sep}node_modules${path.sep}`)) {
        if (/\.d\.[cm]?ts$/.test(target)) {
          fail(
            expression,
            `Runtime import '${specifier}' resolves only to local declarations. Use an explicit type-only import or a source entry point.`,
          );
        } else if (sourceExtensions.includes(path.extname(target))) {
          pending.push(target);
        }
      }
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node)) {
        // Inline type specifiers can retain an empty runtime import under
        // verbatimModuleSyntax. Only whole-statement type imports are erased.
        if (!node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const inlineTypes =
            !node.importClause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly);
          inspect(
            node.moduleSpecifier,
            inlineTypes
              ? "Use a whole-statement import type to erase this runtime edge."
              : undefined,
          );
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (!node.isTypeOnly) {
          const inlineTypes =
            node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly);
          inspect(
            node.moduleSpecifier,
            inlineTypes
              ? "Use a whole-statement export type to erase this runtime edge."
              : undefined,
          );
        }
      } else if (
        ts.isNewExpression(node) &&
        ((ts.isIdentifier(node.expression) &&
          !importedWorkerConstructors.has(node.expression.text) &&
          ["Worker", "SharedWorker"].includes(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            ["globalThis", "window", "self"].includes(node.expression.expression.text) &&
            ["Worker", "SharedWorker"].includes(node.expression.name.text)))
      ) {
        const url = node.arguments?.[0];
        const base = url && ts.isNewExpression(url) ? url.arguments?.[1] : undefined;
        if (
          url &&
          ts.isNewExpression(url) &&
          ts.isIdentifier(url.expression) &&
          url.expression.text === "URL" &&
          base &&
          ts.isPropertyAccessExpression(base) &&
          base.name.text === "url" &&
          ts.isMetaProperty(base.expression) &&
          base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
        ) {
          inspect(url.arguments?.[0]);
        } else {
          fail(node, "Worker entry cannot be checked; use new URL(literal, import.meta.url).");
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        inspect(node.moduleReference.expression);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "glob" &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        fail(node, "import.meta.glob cannot be checked; use literal imports.");
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        inspect(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { failures, checkedFiles: visited.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = checkRendererBoundary(root);
  if (result.failures.length) {
    console.error(result.failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Renderer boundary passed (${result.checkedFiles} first-party runtime source files).`,
    );
  }
}
