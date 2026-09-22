import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL(".", import.meta.url));
const check = process.argv.includes("--check");
const result = await build({
  absWorkingDir: directory,
  entryPoints: ["desktop.ts"],
  outfile: "dist/desktop.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  write: !check,
});
if (check) {
  const expected = await readFile(new URL("./dist/desktop.js", import.meta.url));
  if (!expected.equals(Buffer.from(result.outputFiles[0].contents))) {
    throw new Error(
      "PR Review browser bundle is stale. Run node examples/desktop-extensions/pr-review/build.mjs",
    );
  }
  console.log("PR Review browser bundle matches its source.");
}
