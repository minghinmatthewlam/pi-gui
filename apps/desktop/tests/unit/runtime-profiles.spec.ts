import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { discoverLittleCoder } from "../../electron/runtime/little-coder-discovery";
import { LittleCoderRpc } from "../../electron/runtime/little-coder-rpc";
import { RuntimeProfileStore } from "../../electron/persistence/runtime-profile-store";

const jiti = createJiti(__filename);
let DesktopRuntimeProfiles: typeof import("../../electron/runtime/runtime-profiles").DesktopRuntimeProfiles;
test.beforeAll(async () => {
  ({ DesktopRuntimeProfiles } = await jiti.import<
    typeof import("../../electron/runtime/runtime-profiles")
  >("../../electron/runtime/runtime-profiles.ts"));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wp002-runtime-"));
  const packageRoot = join(root, "package with spaces");
  const pi = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent");
  const cwd = join(root, "workspace");
  const userDataDir = join(root, "userData");
  await Promise.all([
    mkdir(join(packageRoot, "bin"), { recursive: true }),
    mkdir(join(packageRoot, "skills"), { recursive: true }),
    mkdir(join(packageRoot, ".pi/extensions"), { recursive: true }),
    mkdir(join(pi, "dist"), { recursive: true }),
    mkdir(cwd),
    mkdir(userDataDir),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "little-coder",
        version: "1.20.0",
        bin: { "little-coder": "bin/little-coder.mjs" },
      }),
    ),
    writeFile(join(packageRoot, "AGENTS.md"), "Synthetic package marker, not a prompt."),
    writeFile(
      join(pi, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.83.0",
        bin: { pi: "dist/cli.js" },
      }),
    ),
    writeFile(join(pi, "dist/cli.js"), "// fixture metadata only"),
    readFile(resolve(__dirname, "../fixtures/little-coder-rpc.mjs")).then((contents) =>
      writeFile(join(packageRoot, "bin/little-coder.mjs"), contents),
    ),
  ]);
  const host = (environment?: NodeJS.ProcessEnv) =>
    new DesktopRuntimeProfiles(
      userDataDir,
      { agentDir: join(root, "standard-agent") },
      { enabled: true, packageRoot, environment },
    );
  return { root, packageRoot, cwd, userDataDir, host };
}

test("Standard Pi remains the default and missing Little Coder cannot affect it", async () => {
  const { root, userDataDir } = await fixture();
  const profiles = new DesktopRuntimeProfiles(userDataDir, {
    agentDir: join(root, "standard-agent"),
    catalogFilePath: join(userDataDir, "catalogs.json"),
  });
  const ws = await profiles.standardDriver.syncWorkspace(root);
  const session = await profiles.standardDriver.createSession(ws.workspace);
  expect(session.status).toBe("idle");
  await profiles.standardDriver.closeSession(session.ref);
  expect(await profiles.diagnostics()).toMatchObject([
    { id: "standard-pi", available: true, default: true },
    { id: "little-coder", available: false, default: false },
  ]);
  await expect(profiles.bootstrapLittleCoder({ cwd: root })).rejects.toThrow("disabled");
  await profiles.close();
});

test("discovery rejects wrong versions, missing dependencies, and escaping launchers", async () => {
  const { packageRoot, root } = await fixture();
  expect(await discoverLittleCoder(packageRoot)).toMatchObject({
    version: "1.20.0",
    piVersion: "0.83.0",
  });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "little-coder", version: "2.0.0" }),
  );
  await expect(discoverLittleCoder(packageRoot)).rejects.toThrow("1.20.0");
  const second = await fixture();
  await writeFile(
    join(second.packageRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }),
  );
  await expect(discoverLittleCoder(second.packageRoot)).rejects.toThrow("0.83.0");
  const third = await fixture();
  await writeFile(join(root, "outside.mjs"), "export {};");
  const launcher = join(third.packageRoot, "bin/little-coder.mjs");
  await rename(launcher, launcher + ".saved");
  await symlink(join(root, "outside.mjs"), launcher);
  await expect(discoverLittleCoder(third.packageRoot)).rejects.toThrow("escapes");
  const fourth = await fixture();
  await rename(
    join(fourth.packageRoot, "node_modules"),
    join(fourth.packageRoot, "saved-dependency"),
  );
  await expect(discoverLittleCoder(fourth.packageRoot)).rejects.toThrow("unavailable");
});

test("bootstrap records upstream identity and resumes it after host restart without changing transcript", async () => {
  const f = await fixture();
  const first = f.host();
  const session = await first.bootstrapLittleCoder({ cwd: f.cwd });
  expect(await session.getCommands()).toEqual(["fixture-command"]);
  await session.cancel();
  const before = await readFile(session.binding.sessionFile);
  await first.close();
  const second = f.host();
  const resumed = await second.bootstrapLittleCoder({
    cwd: f.cwd,
    sessionFile: session.binding.sessionFile,
  });
  expect(resumed.binding).toEqual(session.binding);
  expect(await readFile(session.binding.sessionFile)).toEqual(before);
  await expect(
    second.bootstrapLittleCoder({ cwd: f.cwd, sessionFile: session.binding.sessionFile }),
  ).rejects.toThrow("already open");
  await resumed.close();
  await second.close();
});

test("two bootstraps use separate processes, workspaces and session identities", async () => {
  const f = await fixture();
  const other = join(f.root, "other");
  await mkdir(other);
  const host = f.host();
  try {
    const [a, b] = await Promise.all([
      host.bootstrapLittleCoder({ cwd: f.cwd }),
      host.bootstrapLittleCoder({ cwd: other }),
    ]);
    expect(a.pid).not.toBe(b.pid);
    expect(a.binding.sessionId).not.toBe(b.binding.sessionId);
    expect(a.binding.cwd).toBe(f.cwd);
    expect(b.binding.cwd).toBe(other);
    expect(await a.getCommands()).toEqual(["fixture-command"]);
    expect(await b.getCommands()).toEqual(["fixture-command"]);
  } finally {
    await host.close();
  }
});

test("a second host cannot open a leased session and can resume after release", async () => {
  const f = await fixture();
  const first = f.host();
  const second = f.host();
  try {
    const session = await first.bootstrapLittleCoder({ cwd: f.cwd });
    await expect(
      second.bootstrapLittleCoder({ cwd: f.cwd, sessionFile: session.binding.sessionFile }),
    ).rejects.toThrow("leased");
    await session.close();
    const resumed = await second.bootstrapLittleCoder({
      cwd: f.cwd,
      sessionFile: session.binding.sessionFile,
    });
    expect(resumed.binding).toEqual(session.binding);
  } finally {
    await first.close();
    await second.close();
  }
});

test("the reported identity must match the requested session on resume", async () => {
  const f = await fixture();
  const first = f.host();
  const session = await first.bootstrapLittleCoder({ cwd: f.cwd });
  await first.close();
  const wrong = f.host({ WP002_FIXTURE_MODE: "wrong-session" });
  try {
    await expect(
      wrong.bootstrapLittleCoder({ cwd: f.cwd, sessionFile: session.binding.sessionFile }),
    ).rejects.toThrow("different session");
  } finally {
    await wrong.close();
  }
});

test("unknown bindings, moved workspaces, corrupt metadata and wrong resume identities fail closed", async () => {
  const f = await fixture();
  const host = f.host();
  const session = await host.bootstrapLittleCoder({ cwd: f.cwd });
  await session.close();
  await expect(
    host.bootstrapLittleCoder({ cwd: f.root, sessionFile: session.binding.sessionFile }),
  ).rejects.toThrow("another workspace");
  const unowned = join(f.root, "unowned.jsonl");
  await writeFile(unowned, "{}");
  await expect(host.bootstrapLittleCoder({ cwd: f.cwd, sessionFile: unowned })).rejects.toThrow(
    "no verified",
  );
  await writeFile(
    session.binding.sessionFile,
    JSON.stringify({ type: "session", id: "wrong", cwd: f.cwd }) + "\n",
  );
  await expect(
    host.bootstrapLittleCoder({ cwd: f.cwd, sessionFile: session.binding.sessionFile }),
  ).rejects.toThrow("header");
  const profilePath = join(f.userDataDir, "runtime-profiles.json");
  await writeFile(profilePath, '{"version":999,"bindings":[]}');
  const store = new RuntimeProfileStore(profilePath);
  await expect(store.bind(session.binding)).rejects.toThrow("Invalid");
  expect(await readFile(profilePath, "utf8")).toBe('{"version":999,"bindings":[]}');
  await host.close();
});

for (const mode of ["malformed", "oversize", "eof", "timeout", "wrong-command", "wrong-id"]) {
  test(`RPC rejects ${mode} and closes its owned process`, async () => {
    const f = await fixture();
    const rpc = new LittleCoderRpc({
      launcher: join(f.packageRoot, "bin/little-coder.mjs"),
      cwd: f.cwd,
      agentDir: join(f.root, "agent"),
      timeoutMs: 250,
      environment: { WP002_FIXTURE_MODE: mode },
    });
    await expect(rpc.command("get_state")).rejects.toThrow();
    await rpc.close();
    if (rpc.pid !== undefined) expect(() => process.kill(rpc.pid!, 0)).toThrow();
  });
}

test("bootstrap permission dialogs are cancelled and cancellation reaches the process", async () => {
  const f = await fixture();
  const host = f.host({ WP002_FIXTURE_MODE: "dialog" });
  try {
    const started = host.bootstrapLittleCoder({ cwd: f.cwd });
    const session = await started;
    await session.cancel();
    expect(
      JSON.parse(await readFile(join(f.userDataDir, "little-coder/agent/dialog.json"), "utf8")),
    ).toEqual({ type: "extension_ui_response", id: "permission-1", cancelled: true });
    expect(await readFile(join(f.userDataDir, "little-coder/agent/aborted"), "utf8")).toBe("yes");
  } finally {
    await host.close();
  }
});

test("POSIX shutdown terminates launcher descendants too", async () => {
  test.skip(
    process.platform === "win32",
    "POSIX process-group regression; Windows needs its taskkill lane.",
  );
  const f = await fixture();
  const marker = join(f.root, "descendant-stopped");
  const rpc = new LittleCoderRpc({
    launcher: join(f.packageRoot, "bin/little-coder.mjs"),
    cwd: f.cwd,
    agentDir: join(f.root, "agent"),
    environment: { WP002_FIXTURE_MODE: "descendant", WP002_DESCENDANT_MARKER: marker },
  });
  try {
    await rpc.command("get_state");
    await expect.poll(async () => readFile(marker + ".ready", "utf8").catch(() => "")).not.toBe("");
  } finally {
    await rpc.close();
  }
  await expect.poll(async () => readFile(marker, "utf8").catch(() => "")).toBe("stopped");
});
