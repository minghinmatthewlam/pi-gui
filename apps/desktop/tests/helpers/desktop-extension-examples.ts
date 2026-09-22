import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { commitAllInGitRepo, initGitRepo } from "./electron-app";

export const desktopExtensionExamplesDirectory = resolve(
  __dirname,
  "../../../../examples/desktop-extensions",
);

/** Real local Git history plus offline GitHub metadata. Never contacts GitHub. */
export async function createExamplePrFixture(options: {
  readonly workspacePath: string;
  readonly artifactDir: string;
}): Promise<{
  readonly base: string;
  readonly head: string;
  readonly envOverrides: { PATH: string };
  advanceHead(source: string): Promise<string>;
}> {
  const { workspacePath, artifactDir } = options;
  await initGitRepo(workspacePath);
  await writeFile(
    join(workspacePath, "search.ts"),
    "export const search = (query) => query ? [query] : [];\n",
  );
  await commitAllInGitRepo(workspacePath, "Before example PR");
  const execute = promisify(execFile);
  const gitHead = async () =>
    (
      await execute("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" })
    ).stdout.trim();
  const base = await gitHead();
  await writeFile(join(workspacePath, "search.ts"), "export const search = (query) => [query];\n");
  await commitAllInGitRepo(workspacePath, "Example PR head");
  const head = await gitHead();
  const bin = join(artifactDir, "example-pr-bin");
  await mkdir(bin, { recursive: true });
  const metadataPath = join(bin, "pr.json");
  const metadata = {
    number: 142,
    url: "https://github.com/example/offline/pull/142",
    title: "Search fixture",
    headRefName: "search-fixture",
    headRefOid: head,
    baseRefOid: base,
  };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(metadataPath)}, 'utf8'));\n`,
  );
  await chmod(gh, 0o755);
  return {
    base,
    head,
    envOverrides: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    async advanceHead(source) {
      await writeFile(join(workspacePath, "search.ts"), source);
      await commitAllInGitRepo(workspacePath, "Move the PR head");
      const next = await gitHead();
      await writeFile(metadataPath, JSON.stringify({ ...metadata, headRefOid: next }));
      return next;
    },
  };
}
