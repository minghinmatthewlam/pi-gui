import { statSync } from "node:fs";
import path from "node:path";

// Validate configuration only; never read or print credential contents.
const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR?.trim();
if (process.env.PI_APP_REAL_AUTH !== "1" || !source || !path.isAbsolute(source)) {
  console.error(
    "Live tests require PI_APP_REAL_AUTH=1 and PI_APP_REAL_AUTH_SOURCE_DIR=/absolute/path/to/agent. No provider tests ran.",
  );
  process.exit(2);
}
try {
  if (!statSync(source).isDirectory() || !statSync(path.join(source, "auth.json")).isFile()) {
    throw new Error("Missing auth source");
  }
} catch {
  console.error(
    "Live auth source must be an existing directory containing auth.json. No provider tests ran.",
  );
  process.exit(2);
}
