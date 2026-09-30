#!/usr/bin/env node
// A stand-in for the GitHub CLI in tests. It answers the fixed argv the GitHub view sends
// from the JSON file named by FAKE_GH_RESPONSES, keyed "repo", "pr:open", "issue:closed",
// "issue:view:216"... (a missing list is empty; a missing view fails like gh's "not found"),
// logs each call to FAKE_GH_LOG, and fails like gh when FAKE_GH_FAIL holds a message.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_GH_FAIL) {
  process.stderr.write(process.env.FAKE_GH_FAIL);
  process.exit(1);
}
const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES ?? "", "utf8"));
const key =
  args[0] === "repo"
    ? "repo"
    : args[1] === "view"
      ? `${args[0]}:view:${args[2]}`
      : `${args[0]}:${args[args.indexOf("--state") + 1]}`;
if (args[1] === "view" && !(key in responses)) {
  process.stderr.write(`no ${args[0]} found (fake gh has no "${key}")`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(responses[key] ?? []));
