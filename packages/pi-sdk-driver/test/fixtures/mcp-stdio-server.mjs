#!/usr/bin/env node
// A minimal MCP server over stdio (newline-delimited JSON-RPC) for tests. It offers one tool,
// `write_marker`, which appends its `text` to `<markerDir>/called.txt`. Connecting writes
// `<markerDir>/initialized.txt`, so a test can tell a session started the server.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const markerDir = process.argv[2];
if (!markerDir) {
  process.stderr.write("usage: mcp-stdio-server.mjs <markerDir>\n");
  process.exit(2);
}
mkdirSync(markerDir, { recursive: true });

const TOOL = {
  name: "write_marker",
  description: "Writes the given text to the test's marker file.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to write" } },
    required: ["text"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(request) {
  switch (request.method) {
    case "initialize":
      appendFileSync(join(markerDir, "initialized.txt"), `${process.pid}\n`);
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-gui-test-server", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      const text = String(request.params?.arguments?.text ?? "");
      appendFileSync(join(markerDir, "called.txt"), `${text}\n`);
      return { content: [{ type: "text", text: `wrote ${text}` }] };
    }
    default:
      return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // Notifications (no id) need no answer.
  if (request.id === undefined || request.id === null) return;
  const result = handle(request);
  if (result === undefined) {
    send({ id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
  } else {
    send({ id: request.id, result });
  }
});
