import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

// Check resolved first-party imports, including type edges. A host command must
// not get domain behavior from a renderer feature, even through a shared helper.
export function checkHostBoundary(root) {
  root = realpathSync(root);
  const desktop = path.join(root, "apps/desktop");
  const config = ts.readConfigFile(path.join(desktop, "tsconfig.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, desktop);
  const pending = [
    ...ts.sys.readDirectory(path.join(desktop, "electron"), [".ts", ".mts", ".tsx"]),
    ...["catalogs", "session-driver", "pi-sdk-driver"].flatMap((name) =>
      ts.sys.readDirectory(path.join(root, "packages", name, "src"), [".ts", ".mts"]),
    ),
  ];
  const seen = new Set();
  const failures = [];
  const cache = ts.createModuleResolutionCache(root, (file) => file, parsed.options);
  while (pending.length) {
    const file = realpathSync(pending.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function inspect(expression) {
      if (!expression || !ts.isStringLiteralLike(expression)) return;
      const resolved = ts.resolveModuleName(
        expression.text,
        file,
        parsed.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!resolved) return; // TypeScript checks resolution; Node/external imports are valid here.
      const target = realpathSync(resolved.resolvedFileName);
      if (!inside(root, target) || target.includes(`${path.sep}node_modules${path.sep}`)) return;
      const { line } = source.getLineAndCharacterOfPosition(expression.getStart(source));
      if (inside(path.join(root, "packages"), file) && inside(path.join(root, "apps"), target)) {
        failures.push(
          `${path.relative(root, file)}:${line + 1}: Package source cannot depend on app implementation.`,
        );
        return;
      }
      const reverseCatalogDependency =
        inside(path.join(root, "packages/catalogs"), file) &&
        inside(path.join(root, "packages/pi-sdk-driver"), target);
      const forbidden =
        inside(path.join(desktop, "src"), target) ||
        inside(path.join(desktop, "tests"), target) ||
        /^packages\/[^/]+\/tests?\//.test(path.relative(root, target).replaceAll(path.sep, "/"));
      if (reverseCatalogDependency) {
        failures.push(
          `${path.relative(root, file)}:${line + 1}: Catalog storage cannot depend on the Pi adapter; use catalog/session contracts.`,
        );
        return;
      }
      if (forbidden) {
        failures.push(
          `${path.relative(root, file)}:${line + 1}: Host code cannot import renderer or test implementation '${path.relative(root, target)}'; move genuinely shared values to contracts.`,
        );
      } else if (/\.[cm]?[jt]sx?$/.test(target)) {
        pending.push(target);
      }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        inspect(node.moduleSpecifier);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        inspect(node.argument.literal);
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        inspect(node.moduleReference.expression);
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        inspect(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkHostBoundary(fileURLToPath(new URL("../", import.meta.url)));
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Host dependencies stay outside renderer and test implementation.");
}
