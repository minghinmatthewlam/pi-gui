// Synthetic RPC process: no provider, model, copied prompts, or upstream behavior.
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const mode = process.env.WP002_FIXTURE_MODE;
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "sessions"), { recursive: true });
const resumeAt = args.indexOf("--session");
const sessionFile =
  resumeAt >= 0 ? args[resumeAt + 1] : join(agentDir, "sessions", randomUUID() + ".jsonl");
const id =
  resumeAt >= 0 ? JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id : randomUUID();
if (resumeAt < 0)
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }) + "\n",
  );
if (mode === "descendant") {
  spawn(
    process.execPath,
    [
      "-e",
      `
    require("fs").writeFileSync(process.argv[1] + ".ready", String(process.pid));
    process.on("SIGTERM", () => { require("fs").writeFileSync(process.argv[1], "stopped"); process.exit(0); });
    setInterval(() => {}, 1000);
  `,
      process.env.WP002_DESCENDANT_MARKER,
    ],
    { stdio: "ignore" },
  );
}
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "extension_ui_response") {
    writeFileSync(join(agentDir, "dialog.json"), JSON.stringify(request));
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (mode === "oversize") {
    process.stdout.write("x".repeat(1_048_577));
    return;
  }
  if (mode === "eof") {
    process.exit(0);
  }
  if (mode === "timeout") return;
  if (mode === "wrong-command") {
    out({ type: "response", id: request.id, command: "wrong", success: true });
    return;
  }
  if (mode === "wrong-id") {
    out({ type: "response", id: "unknown", command: request.type, success: true });
    return;
  }
  if (request.type === "get_state") {
    if (mode === "dialog")
      out({
        type: "extension_ui_request",
        id: "permission-1",
        method: "confirm",
        title: "write",
        message: "allow?",
      });
    out({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data: { sessionFile, sessionId: mode === "wrong-session" ? "different" : id },
    });
  } else if (request.type === "get_commands") {
    out({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data: { commands: [{ name: "fixture-command", source: "extension" }] },
    });
  } else if (request.type === "abort") {
    writeFileSync(join(agentDir, "aborted"), "yes");
    out({ type: "response", id: request.id, command: request.type, success: true });
  }
});
process.on("SIGTERM", () => {
  process.exit(0);
});
