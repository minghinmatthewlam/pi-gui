import { context } from "esbuild";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { browserBuildOptions } from "./browser-build-options.mjs";

const bundle = await context(browserBuildOptions);
let buildQueue = Promise.resolve();
let stopping = false;
const diagnosticsHost = {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};
const reportDiagnostic = (diagnostic) => {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], diagnosticsHost));
};
const host = ts.createWatchCompilerHost(
  fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  {},
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  reportDiagnostic,
  reportDiagnostic,
);
const afterProgramCreate = host.afterProgramCreate;
host.afterProgramCreate = (program) => {
  afterProgramCreate?.(program);
  // tsc also emits frame-bridge.js. Bundle after every completed TS emit,
  // serially, so a later TS update can never leave the unbundled entry last.
  buildQueue = buildQueue
    .then(async () => {
      if (stopping) return;
      await bundle.rebuild();
      console.log("[extension-ui] TypeScript and browser bridge updated");
    })
    .catch((error) => {
      console.error("[extension-ui] Browser bridge build failed:", error);
    });
};
const watcher = ts.createWatchProgram(host);

async function stop(code) {
  if (stopping) return;
  stopping = true;
  watcher.close();
  await buildQueue;
  await bundle.dispose();
  process.exitCode = code;
}

process.once("SIGINT", () => {
  stop(130).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  stop(143).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
