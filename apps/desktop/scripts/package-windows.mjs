import { runElectronBuilder } from "./run-electron-builder.mjs";

const electronBuilderArgs = process.argv.slice(2);
if (electronBuilderArgs.length === 0) {
  throw new Error("Usage: package-windows.mjs <electron-builder args...>");
}

process.exit(await runElectronBuilder(electronBuilderArgs));
