import { parseArgs } from "node:util";
import { applyHomebrewTapUpdate } from "./homebrew-tap-utils.mjs";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "asset-url": { type: "string" },
      "cask-token": { type: "string", default: "pi-gui" },
      "dry-run": { type: "boolean", default: false },
      "sha256": { type: "string" },
      "tap-dir": { type: "string" },
      "version": { type: "string" },
    },
    strict: true,
  });

  for (const key of ["asset-url", "sha256", "tap-dir", "version"]) {
    if (!values[key]) {
      throw new Error(`Missing required argument --${key}.`);
    }
  }

  const result = await applyHomebrewTapUpdate({
    assetUrl: values["asset-url"],
    caskToken: values["cask-token"],
    dryRun: values["dry-run"],
    sha256: values.sha256,
    tapDir: values["tap-dir"],
    version: values.version,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        caskPath: result.caskPath,
        changed: result.changed,
        dryRun: values["dry-run"],
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
