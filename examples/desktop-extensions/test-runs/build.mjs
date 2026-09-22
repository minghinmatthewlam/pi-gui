import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--check")) {
  throw new Error("Usage: node build.mjs [--check]");
}
const check = args.includes("--check");
const outfile = fileURLToPath(new URL("./dist/desktop.js", import.meta.url));
const result = await build({
  // Keep generated source labels stable when invoked from the example directory.
  absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
  entryPoints: [fileURLToPath(new URL("./desktop.ts", import.meta.url))],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  write: !check,
});

if (check) {
  const generated = result.outputFiles?.find((output) => output.path === outfile);
  if (!generated) throw new Error("The browser build did not produce desktop.js.");
  let checkedIn;
  try {
    checkedIn = await readFile(outfile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "The Test Runs browser bundle is missing. Run node examples/desktop-extensions/test-runs/build.mjs.",
    );
  }
  if (!checkedIn.equals(Buffer.from(generated.contents))) {
    throw new Error(
      "The Test Runs browser bundle is stale. Run node examples/desktop-extensions/test-runs/build.mjs.",
    );
  }
  console.log("Test Runs browser bundle is current.");
}
