import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import {
  applyHomebrewTapUpdate,
  computeFileSha256,
  fetchReleaseAssetUrl,
} from "./homebrew-tap-utils.mjs";

const execFile = promisify(execFileCallback);

async function git(tapDir, args) {
  return execFile("git", ["-C", tapDir, ...args], { encoding: "utf8" });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "asset-name": { type: "string" },
      "asset-url": { type: "string" },
      "cask-token": { type: "string", default: "pi-gui" },
      "commit": { type: "boolean", default: false },
      "commit-message": { type: "string" },
      "dmg-path": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "git-user-email": { type: "string", default: "41898282+github-actions[bot]@users.noreply.github.com" },
      "git-user-name": { type: "string", default: "github-actions[bot]" },
      "github-repo": { type: "string" },
      "push": { type: "boolean", default: false },
      "sha256": { type: "string" },
      "tag": { type: "string" },
      "tap-dir": { type: "string" },
      "version": { type: "string" },
    },
    strict: true,
  });

  for (const key of ["tap-dir", "version"]) {
    if (!values[key]) {
      throw new Error(`Missing required argument --${key}.`);
    }
  }

  const assetUrl =
    values["asset-url"] ??
    (await fetchReleaseAssetUrl({
      assetName: values["asset-name"] ?? "",
      repo: values["github-repo"] ?? "",
      tag: values.tag ?? "",
      token: process.env.GITHUB_TOKEN,
    }));

  const sha256 = values.sha256 ?? (values["dmg-path"] ? await computeFileSha256(values["dmg-path"]) : undefined);
  if (!sha256) {
    throw new Error("Pass either --sha256 or --dmg-path.");
  }

  const result = await applyHomebrewTapUpdate({
    assetUrl,
    caskToken: values["cask-token"],
    dryRun: values["dry-run"],
    sha256,
    tapDir: values["tap-dir"],
    version: values.version,
  });

  if (!result.changed) {
    process.stdout.write(`${JSON.stringify({ changed: false, caskPath: result.caskPath }, null, 2)}\n`);
    return;
  }

  const shouldCommit = values.commit || values.push;
  const shouldPush = values.push;

  if (values["dry-run"]) {
    process.stdout.write(
      `${JSON.stringify(
        {
          assetUrl,
          caskPath: result.caskPath,
          changed: result.changed,
          dryRun: true,
          sha256,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!shouldCommit) {
    process.stdout.write(
      `${JSON.stringify(
        {
          assetUrl,
          caskPath: result.caskPath,
          changed: true,
          committed: false,
          pushed: false,
          sha256,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await git(values["tap-dir"], ["config", "user.name", values["git-user-name"]]);
  await git(values["tap-dir"], ["config", "user.email", values["git-user-email"]]);
  await git(values["tap-dir"], ["add", result.caskPath]);
  await git(values["tap-dir"], [
    "commit",
    "-m",
    values["commit-message"] ?? `Update ${values["cask-token"]} cask to ${values.version}`,
  ]);

  if (shouldPush) {
    await git(values["tap-dir"], ["push", "origin", "HEAD"]);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        assetUrl,
        caskPath: result.caskPath,
        changed: true,
        committed: true,
        pushed: shouldPush,
        sha256,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
