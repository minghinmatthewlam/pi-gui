import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkWorkspaceTypechecks(root, pnpmPath) {
  root = realpathSync(root);
  if (!pnpmPath) throw new Error("Run this guard through pnpm check:workspaces.");
  const projects = JSON.parse(
    execFileSync(process.execPath, [pnpmPath, "-r", "list", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const workspaces = projects.filter((project) => realpathSync(project.path) !== root);
  if (!workspaces.length) throw new Error("No workspaces discovered; refusing to skip typechecks.");
  const failures = [];
  for (const workspace of workspaces) {
    const manifest = JSON.parse(readFileSync(path.join(workspace.path, "package.json"), "utf8"));
    if (typeof manifest.scripts?.typecheck !== "string" || !manifest.scripts.typecheck.trim()) {
      failures.push(
        `${path.relative(root, workspace.path)}/package.json: missing scripts.typecheck. Add a typecheck command so this workspace participates in CI.`,
      );
    }
  }
  return { failures, count: workspaces.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkWorkspaceTypechecks(
    fileURLToPath(new URL("../", import.meta.url)),
    process.env.npm_execpath,
  );
  if (result.failures.length) {
    console.error(result.failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`All ${result.count} workspaces declare typecheck commands.`);
  }
}
