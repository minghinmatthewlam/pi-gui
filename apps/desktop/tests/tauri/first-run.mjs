#!/usr/bin/env node
// First-run check of the real Tauri window on Linux, through tauri-driver and WebKitWebDriver:
// the window opens with the app's UI, a folder is added through the native folder picker, a
// thread starts, a scripted provider's reply streams into the timeline, and closing the window
// quits the app with pi stopped and state saved.
//
// Needs a built app (`cargo build` in apps/desktop/src-tauri after `pnpm build`), an X display
// in DISPLAY, `tauri-driver`, `WebKitWebDriver` and `xdotool` (for the GTK folder picker).
//
//   DISPLAY=:95 node apps/desktop/tests/tauri/first-run.mjs [--screenshots <dir>]
//
// PI_GUI_TAURI_BIN overrides the app binary; it defaults to $CARGO_TARGET_DIR/debug/pi-gui.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const binary =
  process.env.PI_GUI_TAURI_BIN?.trim() ||
  join(process.env.CARGO_TARGET_DIR?.trim() || join(repoRoot, "target"), "debug", "pi-gui");
const screenshotsArg = process.argv.indexOf("--screenshots");
const screenshotsDir = screenshotsArg > 0 ? resolve(process.argv[screenshotsArg + 1]) : undefined;
const DRIVER_PORT = 4444;
const PROMPT = "Say hello from the Tauri window.";
const DRAFT = "An unsent draft that must survive closing the window";
const REPLY_CHUNKS = [
  "Hello from the scripted provider. ",
  "This reply arrives in pieces, ",
  "so the timeline shows it growing ",
  "while the run is still going.",
];

// A provider in pi's global extensions: no network, a reply streamed in timed chunks.
const providerExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const CHUNKS = ${JSON.stringify(REPLY_CHUNKS)};

export default function scriptedProvider(pi) {
  pi.registerProvider("tauri-check", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "tauri-check",
    models: [{
      id: "scripted",
      name: "Scripted reply",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      const message = (text) => ({
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const stream = createAssistantMessageEventStream();
      void (async () => {
        stream.push({ type: "start", partial: { ...message(""), content: [] } });
        let text = "";
        for (const chunk of CHUNKS) {
          await new Promise((done) => setTimeout(done, 700));
          text += chunk;
          stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message(text) });
        }
        stream.push({ type: "done", reason: "stop", message: message(text) });
      })();
      return stream;
    },
  });
}
`;

function log(message) {
  console.log(`[tauri first-run] ${message}`);
}

async function sleep(ms) {
  await new Promise((done) => setTimeout(done, ms));
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-tauri-")));
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  const workspace = join(root, "tauri-first-run");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "# tauri-first-run\n");
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProvider: "tauri-check",
      defaultModel: "scripted",
      enabledModels: ["tauri-check/scripted"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    })}\n`,
  );
  await writeFile(join(agentDir, "extensions", "tauri-check.ts"), providerExtension);
  return { root, userDataDir, agentDir, workspace };
}

/** The W3C WebDriver calls this check needs. */
class WebDriver {
  constructor(base) {
    this.base = base;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${JSON.stringify(payload.value ?? payload)}`);
    }
    return payload.value;
  }

  async start(application) {
    const session = await this.request("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    this.session = `/session/${session.sessionId}`;
  }

  execute(script, ...args) {
    return this.request("POST", `${this.session}/execute/sync`, { script, args });
  }

  async find(selector) {
    const element = await this.request("POST", `${this.session}/element`, {
      using: "css selector",
      value: selector,
    });
    return Object.values(element)[0];
  }

  click(element) {
    return this.request("POST", `${this.session}/element/${element}/click`, {});
  }

  type(element, text) {
    return this.request("POST", `${this.session}/element/${element}/value`, { text });
  }

  async screenshot(name) {
    if (!screenshotsDir) return;
    const png = await this.request("GET", `${this.session}/screenshot`);
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, `${name}.png`), Buffer.from(png, "base64"));
  }

  async end() {
    await this.request("DELETE", this.session).catch(() => undefined);
  }

  /** Polls a page script until it returns something truthy. */
  async waitFor(description, script, timeoutMs = 30_000, ...args) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.execute(script, ...args).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
      await sleep(100);
    }
  }
}

async function waitForDriver(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/status`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error("tauri-driver did not start");
}

/** Processes started under `root` (tauri-driver), so other runs on this machine never count. */
async function descendants(root) {
  const { stdout } = await execFileAsync("ps", ["-e", "-o", "pid=,ppid=,args="]);
  const rows = stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
  const found = [];
  const parents = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        found.push(row);
        grew = true;
      }
    }
  }
  return found;
}

/** Running, not exited: an exited child stays a zombie until its parent reaps it. */
async function isAlive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

/** Answers GTK's folder picker the way a user would: type the path, then choose it. */
async function pickFolderInGtkDialog(path) {
  const { stdout } = await execFileAsync("xdotool", [
    "search",
    "--sync",
    "--onlyvisible",
    "--name",
    "Open workspace folder",
  ]);
  const dialog = stdout.split("\n").filter(Boolean).at(-1);
  // Real key events need the dialog focused; events sent to a window are ignored by GTK.
  await execFileAsync("xdotool", ["windowactivate", "--sync", dialog]).catch(() => undefined);
  // GTK fills the dialog after it maps and drops keys typed before then; it shows no state
  // to wait on from outside.
  await sleep(1_500);
  await execFileAsync("xdotool", ["type", "--delay", "20", path]);
  await sleep(500);
  await execFileAsync("xdotool", ["key", "Return"]);
  await sleep(800);
  // In a folder picker, Return on a typed folder opens it; choosing it is the dialog's button.
  const stillOpen = await execFileAsync("xdotool", [
    "search",
    "--onlyvisible",
    "--name",
    "Open workspace folder",
  ])
    .then(() => true)
    .catch(() => false);
  if (stillOpen) {
    await execFileAsync("xdotool", ["key", "Return"]);
  }
}

/**
 * The window manager's close (Alt+F4), which asks the app first. WebDriver's own window close
 * destroys the webview without asking, so it would skip the app's close handling.
 */
async function closeAppWindowLikeAUser() {
  const { stdout } = await execFileAsync("xdotool", ["search", "--onlyvisible", "--name", "^pi$"]);
  const window = stdout.split("\n").filter(Boolean)[0];
  await execFileAsync("xdotool", ["windowactivate", "--sync", window]).catch(() => undefined);
  await execFileAsync("xdotool", ["key", "alt+F4"]);
}

async function main() {
  if (!existsSync(binary)) throw new Error(`Build the app first: ${binary}`);
  const paths = await fixture();
  log(`fixture in ${paths.root}`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY")) delete env[key];
  }
  Object.assign(env, {
    PI_APP_USER_DATA_DIR: paths.userDataDir,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_APP_TEST_MODE: "foreground",
  });
  const driverOutput = [];
  const driver = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [driver.stdout, driver.stderr]) {
    stream.on("data", (chunk) => driverOutput.push(chunk.toString()));
  }
  const webdriver = new WebDriver(`http://127.0.0.1:${DRIVER_PORT}`);
  try {
    await waitForDriver(webdriver.base);
    await webdriver.start(binary);
    log("session started");

    // 1. The real UI, with window.piApp from the Tauri adapter.
    await webdriver.waitFor(
      "the app UI",
      `return Boolean(window.piApp && document.querySelector('[data-testid="topbar"]'))`,
    );
    const platform = await webdriver.execute("return window.piApp.platform");
    log(`UI is up (piApp.platform = ${platform})`);
    const started = await descendants(driver.pid);
    const appPids = started.filter((row) => row.args === binary).map((row) => row.pid);
    const hostPids = started.filter((row) => row.args.includes("pi-host.js")).map((row) => row.pid);
    if (appPids.length !== 1 || hostPids.length !== 1) {
      throw new Error(`Expected one app and one pi host: ${JSON.stringify(started)}`);
    }
    await webdriver.screenshot("1-first-window");

    // 2. Add the folder through the native picker.
    await webdriver.click(await webdriver.find('button[aria-label="Open folder"]'));
    await pickFolderInGtkDialog(paths.workspace);
    await webdriver.waitFor(
      "the folder in the sidebar",
      `return [...document.querySelectorAll('aside *')].some((node) => node.textContent === arguments[0])`,
      15_000,
      "tauri-first-run",
    );
    log("folder added through the native picker");
    await webdriver.screenshot("2-folder-added");

    // 3. Start a thread.
    await webdriver.waitFor(
      "the new thread prompt",
      `return Boolean(document.querySelector('[aria-label="New thread prompt"]'))`,
    );
    const prompt = await webdriver.find('[aria-label="New thread prompt"]');
    await webdriver.click(prompt);
    await webdriver.type(prompt, PROMPT);
    await webdriver.click(await webdriver.find('button[aria-label="Start thread"]'));
    await webdriver.waitFor(
      "the user's message in the timeline",
      `return [...document.querySelectorAll('.timeline-item--user')].some((row) => row.textContent.includes(arguments[0]))`,
      15_000,
      PROMPT,
    );
    log("thread started");

    // 4. The reply streams: the assistant row grows through partial text before it is whole.
    const full = REPLY_CHUNKS.join("").trim();
    const seen = new Set();
    const deadline = Date.now() + 30_000;
    let shotStreaming = false;
    for (;;) {
      const text = await webdriver.execute(
        `const rows = document.querySelectorAll('.timeline-item--assistant .message__content');
         return rows.length ? rows[rows.length - 1].textContent.trim() : "";`,
      );
      if (text) seen.add(text);
      if (text && text !== full && !shotStreaming) {
        shotStreaming = true;
        await webdriver.screenshot("3-streaming");
      }
      if (text === full) break;
      if (Date.now() > deadline) throw new Error(`Reply never completed; last saw: ${text}`);
      await sleep(50);
    }
    const partials = [...seen].filter((text) => text !== full);
    if (partials.length < 2) {
      throw new Error(`Expected the reply to stream; saw only ${JSON.stringify([...seen])}`);
    }
    log(`reply streamed through ${partials.length} partial states`);
    await webdriver.waitFor(
      "the run to settle",
      `return document.querySelector('[data-testid="send"]')?.getAttribute('aria-label') !== 'Stop run'`,
    );
    await sleep(1_500);
    await webdriver.screenshot("4-reply-complete");

    // 5. Closing the last window quits: the unsent draft and state are saved, then pi and the
    // app stop. The draft is closed right after typing, inside the composer's save debounce,
    // so only the close's draft flush can save it.
    const composer = await webdriver.find('[data-testid="composer"]');
    await webdriver.click(composer);
    await webdriver.type(composer, DRAFT);
    await webdriver.screenshot("5-draft");
    await closeAppWindowLikeAUser();
    const closedAt = Date.now();
    const running = async () => {
      const pids = [...appPids, ...hostPids];
      const alive = await Promise.all(pids.map(isAlive));
      return pids.filter((_, index) => alive[index]);
    };
    while ((await running()).length > 0 && Date.now() - closedAt < 10_000) await sleep(100);
    const left = await running();
    if (left.length > 0) throw new Error(`Still running after quit: ${left.join(", ")}`);
    const uiState = JSON.parse(await readFile(join(paths.userDataDir, "ui-state.json"), "utf8"));
    if (!JSON.stringify(uiState).includes(paths.workspace)) {
      throw new Error("ui-state.json does not have the added folder");
    }
    if (!JSON.stringify(uiState).includes(DRAFT)) {
      throw new Error("ui-state.json does not have the draft typed before closing");
    }
    log(
      `quit cleanly in ${Date.now() - closedAt} ms: app and pi host exited, draft and state saved`,
    );
    log("PASS");
    if (process.env.PI_GUI_TAURI_VERBOSE) console.error(driverOutput.join(""));
  } catch (error) {
    await webdriver.screenshot("failure").catch(() => undefined);
    console.error(driverOutput.join(""));
    throw error;
  } finally {
    await webdriver.end();
    driver.kill();
  }
}

main().catch((error) => {
  console.error(`[tauri first-run] FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
});
