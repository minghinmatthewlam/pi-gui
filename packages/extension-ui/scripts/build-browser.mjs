import { build } from "esbuild";
import { browserBuildOptions } from "./browser-build-options.mjs";

await build(browserBuildOptions);
