import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
} from "../dist/mcp-config.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-gui-mcp-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd, globalPath: join(agentDir, "mcp.json") };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

await test("editing one server keeps every other field, key and the file's indentation", () => {
  const { agentDir, cwd, globalPath } = setup();
  const original = {
    autoEnableCodemode: false,
    mcpServers: {
      docs: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
        oauth: { clientId: "abc" },
        exposure: "direct",
      },
      files: { command: "npx", args: ["-y", "server"], env: { SECRET: "s3cret" } },
    },
    somethingElse: { keep: true },
  };
  writeFileSync(globalPath, `${JSON.stringify(original, null, "\t")}\n`);

  setMcpServerEnabled({ agentDir, cwd }, "global", "files", false);
  const disabled = readFileSync(globalPath, "utf8");
  assert.match(disabled, /^\t"autoEnableCodemode"/m, "tab indentation is kept");
  assert.deepEqual(readJson(globalPath), {
    ...original,
    mcpServers: {
      ...original.mcpServers,
      files: { ...original.mcpServers.files, enabled: false },
    },
  });

  setMcpServerEnabled({ agentDir, cwd }, "global", "files", true);
  assert.deepEqual(readJson(globalPath), original, "switching back on deletes `enabled`");

  addMcpServer(agentDir, { name: "local", command: "node", args: ["server.mjs", "--flag"] });
  assert.deepEqual(readJson(globalPath), {
    ...original,
    mcpServers: {
      ...original.mcpServers,
      local: { command: "node", args: ["server.mjs", "--flag"] },
    },
  });

  assert.equal(removeMcpServer(agentDir, "local"), true);
  assert.deepEqual(readJson(globalPath), original);
  assert.equal(removeMcpServer(agentDir, "local"), false);
});

await test("listing returns no secrets and marks project servers", () => {
  const { agentDir, cwd, globalPath } = setup();
  writeFileSync(
    globalPath,
    JSON.stringify({
      mcpServers: {
        docs: {
          url: "https://user:pass@example.com/mcp",
          headers: { Authorization: "Bearer TOKEN" },
          enabled: false,
        },
        files: { command: "npx", args: ["-y", "server"], env: { SECRET: "s3cret" } },
        keyed: { url: "https://example.com/mcp?api_key=QUERYKEY#frag", env: {} },
        signin: { url: "https://example.com/oauth", oauth: { clientSecret: "CLIENTSECRET" } },
        broken: { url: "not a url?key=RAWKEY" },
      },
    }),
  );
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { project: { command: "./run" } } }),
  );

  const listing = listMcpServers({ agentDir, cwd });
  assert.deepEqual(listing, {
    globalConfigPath: globalPath,
    servers: [
      {
        name: "docs",
        scope: "global",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: false,
        hasHiddenSettings: true,
      },
      {
        name: "files",
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        enabled: true,
        hasHiddenSettings: true,
      },
      {
        name: "keyed",
        scope: "global",
        transport: "http",
        url: "https://example.com/mcp?…",
        enabled: true,
        hasHiddenSettings: false,
      },
      {
        name: "signin",
        scope: "global",
        transport: "http",
        url: "https://example.com/oauth",
        enabled: true,
        hasHiddenSettings: true,
      },
      {
        name: "broken",
        scope: "global",
        transport: "http",
        url: "(invalid URL)",
        enabled: true,
        hasHiddenSettings: false,
      },
      {
        name: "project",
        scope: "project",
        transport: "stdio",
        command: "./run",
        args: [],
        enabled: true,
        hasHiddenSettings: false,
      },
    ],
    errors: [],
  });
  assert.doesNotMatch(
    JSON.stringify(listing),
    /s3cret|TOKEN|pass|QUERYKEY|frag|CLIENTSECRET|RAWKEY/,
  );

  setMcpServerEnabled({ agentDir, cwd }, "project", "project", false);
  assert.deepEqual(readJson(join(cwd, ".pi", "mcp.json")), {
    mcpServers: { project: { command: "./run", enabled: false } },
  });
});

await test("a file that does not parse is reported and never overwritten", () => {
  const { agentDir, cwd, globalPath } = setup();
  const broken = '{ "mcpServers": { "files": { "command": "npx", } ';
  writeFileSync(globalPath, broken);

  assert.throws(() => addMcpServer(agentDir, { name: "local", command: "node" }), /mcp\.json/);
  assert.throws(() => setMcpServerEnabled({ agentDir, cwd }, "global", "files", false));
  assert.throws(() => removeMcpServer(agentDir, "files"));
  assert.equal(readFileSync(globalPath, "utf8"), broken);

  const listing = listMcpServers({ agentDir, cwd });
  assert.deepEqual(listing.servers, []);
  assert.equal(listing.errors.length, 1);
});

await test("new servers are validated and never replace an existing one", () => {
  const { agentDir, globalPath } = setup();
  assert.throws(() => addMcpServer(agentDir, { name: " ", command: "node" }), /name/);
  assert.throws(() => addMcpServer(agentDir, { name: "a", command: "  " }), /command/);
  assert.throws(() => addMcpServer(agentDir, { name: "a", url: "file:///etc/passwd" }), /URL/);
  assert.throws(() => addMcpServer(agentDir, { name: "a", url: "not a url" }), /URL/);
  assert.equal(existsSync(globalPath), false, "nothing is written for rejected input");

  addMcpServer(agentDir, { name: "remote", url: "https://example.com/mcp" });
  assert.throws(
    () => addMcpServer(agentDir, { name: "remote", command: "node" }),
    /already exists/,
  );
  assert.deepEqual(readJson(globalPath), {
    mcpServers: { remote: { url: "https://example.com/mcp" } },
  });
});

await test("server names follow pi's rule and Object keys are ordinary names", () => {
  const { agentDir, cwd, globalPath } = setup();
  for (const name of ["my docs", "docs.v2", "docs/api", "dócs"]) {
    assert.throws(
      () => addMcpServer(agentDir, { name, command: "node" }),
      /Invalid MCP server name/,
    );
  }
  assert.equal(existsSync(globalPath), false, "nothing is written for rejected names");

  assert.equal(removeMcpServer(agentDir, "toString"), false);
  for (const name of ["toString", "constructor", "__proto__"]) {
    addMcpServer(agentDir, { name, command: "node" });
  }
  assert.deepEqual(savedNames(globalPath), ["toString", "constructor", "__proto__"]);
  assert.deepEqual(
    listMcpServers({ agentDir, cwd }).servers.map((server) => server.name),
    ["toString", "constructor", "__proto__"],
  );
  assert.throws(
    () => addMcpServer(agentDir, { name: "__proto__", command: "node" }),
    /already exists/,
  );

  setMcpServerEnabled({ agentDir, cwd }, "global", "__proto__", false);
  assert.equal(removeMcpServer(agentDir, "__proto__"), true);
  assert.equal(removeMcpServer(agentDir, "constructor"), true);
  assert.equal(removeMcpServer(agentDir, "hasOwnProperty"), false);
  assert.throws(
    () => setMcpServerEnabled({ agentDir, cwd }, "global", "valueOf", false),
    /does not define/,
  );
  assert.deepEqual(savedNames(globalPath), ["toString"]);
});

function savedNames(path: string): string[] {
  return Object.keys((readJson(path) as { mcpServers: object }).mcpServers);
}

await test("stdio arguments that look like credentials are masked in listings", () => {
  const { agentDir, cwd, globalPath } = setup();
  const args = [
    "-y",
    "@example/server",
    "--api-key",
    "ARG_SECRET_1",
    "--token=ARG_SECRET_2",
    "GITHUB_TOKEN=ARG_SECRET_3",
    "--header",
    "Authorization: Bearer ARG_SECRET_4",
    "--password",
    "--verbose",
    "--port",
    "8080",
    "LOG_LEVEL=debug",
    "https://example.com/data",
    "https://example.com/mcp?api_key=ARG_SECRET_5",
    "https://user:ARG_SECRET_6@example.com/mcp",
    "SERVER_URL=https://example.com/mcp?t=ARG_SECRET_7",
  ];
  writeFileSync(globalPath, JSON.stringify({ mcpServers: { tools: { command: "npx", args } } }));

  const [server] = listMcpServers({ agentDir, cwd }).servers;
  assert.deepEqual(server?.args, [
    "-y",
    "@example/server",
    "--api-key",
    "•••",
    "--token=•••",
    "GITHUB_TOKEN=•••",
    "--header",
    "Authorization: •••",
    "--password",
    "--verbose",
    "--port",
    "8080",
    "LOG_LEVEL=debug",
    "https://example.com/data",
    "https://example.com/mcp?…",
    "https://example.com/mcp",
    "SERVER_URL=https://example.com/mcp?…",
  ]);
  assert.doesNotMatch(JSON.stringify(server), /ARG_SECRET/);
  assert.deepEqual(
    (readJson(globalPath) as { mcpServers: { tools: { args: string[] } } }).mcpServers.tools.args,
    args,
    "the file keeps the real values",
  );
});
