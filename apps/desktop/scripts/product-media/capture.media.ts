// Records the README and pi-gui.com product media from a real agent run.
// Run through `pnpm marketing:media`; see apps/desktop/README.md#marketing-media.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { launchDesktop, startThreadFromSurface } from "../../tests/helpers/electron-app";
import { replaceFileAtomically } from "../atomic-output.mts";

const repoRoot = path.resolve(__dirname, "../../../..");
const publishingRoot = process.env.PI_GUI_MARKETING_STAGE_DIR
  ? path.resolve(process.env.PI_GUI_MARKETING_STAGE_DIR)
  : repoRoot;
const mediaDir = path.join(publishingRoot, "apps", "website", "public", "media");
const evidenceRoot = path.join(repoRoot, ".artifacts", "marketing", "product-media");

// Logical window size. Captures run at 2x so stills and video stay sharp on Retina screens.
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
const DISPLAY = ":97";

const HERO_PROMPT =
  "formatPrice in src/price.js prints $12.5 instead of $12.50. Fix it, add a test for cents padding, and run the tests.";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Product media records a real agent run: set PI_GUI_MARKETING_PROVIDER, PI_GUI_MARKETING_MODEL and PI_APP_REAL_AUTH_SOURCE_DIR (the pi agent dir holding auth.json).`,
    );
  }
  return value;
}

async function writeGitWorkspace(root: string, name: string, files: Record<string, string>) {
  const workspace = path.join(root, name);
  for (const [relativePath, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
    await writeFile(path.join(workspace, relativePath), body);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "Initial");
  return workspace;
}

// A second X display sized for 2x capture, so the app renders at devicePixelRatio 2.
async function startDisplay(runDir: string): Promise<ChildProcess> {
  const xvfb = spawn(
    "Xvfb",
    [
      DISPLAY,
      "-screen",
      "0",
      `${WIDTH * SCALE + 120}x${HEIGHT * SCALE + 120}x24`,
      "-nolisten",
      "tcp",
    ],
    { stdio: "ignore" },
  );
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  await expect.poll(() => existsSync(socket), { timeout: 10_000 }).toBe(true);
  // Linux has no SF Pro. When Inter and JetBrains Mono are installed (fonts-inter,
  // fonts-jetbrains-mono, or the user font dir), prefer them so captures resemble the macOS app.
  const hasFamily = (family: string) =>
    execFileSync("fc-match", ["-f", "%{family}", family], { encoding: "utf8" }).startsWith(family);
  const prefer = (target: string, aliases: readonly string[]) =>
    hasFamily(target)
      ? aliases
          .map(
            (family) =>
              `<match target="pattern"><test name="family"><string>${family}</string></test><edit name="family" mode="assign" binding="strong"><string>${target}</string></edit></match>`,
          )
          .join("\n  ")
      : "";
  const fontsConf = path.join(runDir, "fonts.conf");
  await writeFile(
    fontsConf,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${path.join(homedir(), ".local", "share", "fonts")}</dir>
  <dir>${path.join(homedir(), ".fonts")}</dir>
  ${prefer("Inter", ["sans-serif", "system-ui", "Arial", "Liberation Sans", "DejaVu Sans"])}
  ${prefer("JetBrains Mono", ["monospace", "Monospace", "DejaVu Sans Mono", "Liberation Mono"])}
</fontconfig>
`,
  );
  process.env.FONTCONFIG_FILE = fontsConf;
  return xvfb;
}

function startScreenRecording(outputPath: string): () => Promise<void> {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "x11grab",
      "-framerate",
      "30",
      "-draw_mouse",
      "0",
      "-video_size",
      `${WIDTH * SCALE}x${HEIGHT * SCALE}`,
      "-i",
      `${DISPLAY}+0,0`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "14",
      outputPath,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  return () =>
    new Promise((resolve) => {
      ffmpeg.once("exit", () => resolve());
      ffmpeg.stdin?.end("q");
    });
}

// Crops are in logical window pixels. Feature shots crop to the part of the window they
// describe so the app's text stays readable at page size.
interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function publishStill(page: Page, runDir: string, name: string, crop?: Crop): Promise<void> {
  const pngPath = path.join(runDir, `${name}.png`);
  await page.screenshot({ path: pngPath });
  const filter = crop
    ? [
        "-vf",
        `crop=${crop.width * SCALE}:${crop.height * SCALE}:${crop.x * SCALE}:${crop.y * SCALE}`,
      ]
    : [];
  await replaceFileAtomically(path.join(mediaDir, `${name}.webp`), async (temporaryPath) => {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      pngPath,
      ...filter,
      "-c:v",
      "libwebp",
      "-quality",
      "88",
      temporaryPath,
    ]);
  });
}

async function boxOf(locator: Locator): Promise<Crop> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible element to crop to");
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

async function publishVideo(rawPath: string, name: string): Promise<void> {
  await replaceFileAtomically(path.join(mediaDir, `${name}.mp4`), async (temporaryPath) => {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      rawPath,
      "-vf",
      "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "24",
      "-an",
      "-movflags",
      "+faststart",
      temporaryPath,
    ]);
  });
  // The poster is the finished state, so the README and a paused video show the result.
  await replaceFileAtomically(path.join(mediaDir, `${name}-poster.webp`), async (temporaryPath) => {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-sseof",
      "-1",
      "-i",
      rawPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=1920:-2:flags=lanczos",
      "-c:v",
      "libwebp",
      "-quality",
      "85",
      temporaryPath,
    ]);
  });
}

test("capture product media from a real run", async () => {
  test.skip(
    process.platform !== "linux",
    "Product media is captured on Linux with Xvfb and x11grab.",
  );
  const provider = requireEnv("PI_GUI_MARKETING_PROVIDER");
  const model = requireEnv("PI_GUI_MARKETING_MODEL");
  const authSource = requireEnv("PI_APP_REAL_AUTH_SOURCE_DIR");
  const auth = JSON.parse(await readFile(path.join(authSource, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (!auth[provider]) throw new Error(`No saved credentials for ${provider} in ${authSource}`);

  await mkdir(mediaDir, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(evidenceRoot, "run-"));
  // Credentials stay outside the retained evidence tree.
  const privateDir = await mkdtemp(path.join(tmpdir(), "pi-gui-media-"));
  await chmod(privateDir, 0o700);
  const agentDir = path.join(privateDir, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ [provider]: auth[provider] }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${model}`],
    }),
  );

  // A home directory with a short prompt, so the integrated terminal reads cleanly.
  const home = path.join(runDir, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".bashrc"), "PS1='\\W $ '\n");
  const code = path.join(home, "code");
  const cart = await writeGitWorkspace(code, "tidy-cart", {
    "package.json": `${JSON.stringify({ name: "tidy-cart", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "README.md": "# tidy-cart\n\nA tiny cart and pricing library.\n",
    "src/price.js": `export function formatPrice(cents, currency = "USD") {\n  const dollars = Math.floor(cents / 100);\n  const rest = cents % 100;\n  return \`\${currency === "USD" ? "$" : currency + " "}\${dollars}.\${rest}\`;\n}\n\nexport function applyDiscount(cents, percent) {\n  return cents - (cents * percent) / 100;\n}\n`,
    "src/cart.js": `import { applyDiscount } from "./price.js";\n\nexport function cartTotal(items, discountPercent = 0) {\n  const subtotal = items.reduce((sum, item) => sum + item.cents * item.qty, 0);\n  return applyDiscount(subtotal, discountPercent);\n}\n`,
    "test/price.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatPrice } from "../src/price.js";\n\ntest("formats whole dollars", () => {\n  assert.equal(formatPrice(1200), "$12.00");\n});\n`,
  });
  const notes = await writeGitWorkspace(code, "field-notes", {
    "package.json": `${JSON.stringify({ name: "field-notes", private: true }, null, 2)}\n`,
    "README.md": "# field-notes\n\nA static notes site.\n",
    "content/2026-09-01-release.md": "# Release notes\n\n- Faster search\n- Dark mode\n",
    "src/search.ts":
      "export function search(notes: string[], query: string) {\n  return notes.filter((note) => note.includes(query));\n}\n",
  });

  const xvfb = await startDisplay(runDir);
  const harness = await launchDesktop(path.join(runDir, "profile"), {
    agentDir,
    initialWorkspaces: [cart, notes],
    scrubProviderEnv: true,
    envOverrides: {
      PI_APP_TEST_MODE: undefined,
      DISPLAY,
      GDK_SCALE: String(SCALE),
      HOME: home,
      FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
    },
  });
  let stopRecording: (() => Promise<void>) | undefined;
  const rawVideo = path.join(runDir, "hero-raw.mkv");
  try {
    await harness.focusWindow();
    const page = await harness.firstWindow();
    await harness.electronApp.evaluate(
      ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds),
      { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    );
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(SCALE);
    const send = page.getByTestId("send");
    const workbench = page.getByTestId("workbench");
    const idle = () =>
      expect(send).not.toHaveAttribute("aria-label", "Stop run", { timeout: 240_000 });
    const openTool = async (name: "Changes" | "Files" | "Terminal") => {
      if (!(await workbench.isVisible())) await page.getByTestId("toggle-side-panel").click();
      const tab = workbench.getByRole("tab", { name, exact: true });
      if (!(await tab.count())) {
        const chooser = page.getByTestId("workbench-chooser");
        if (!(await chooser.isVisible())) await page.getByTestId("workbench-add-tab").click();
        await chooser.getByRole("button", { name, exact: true }).click();
      }
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    };
    const settle = (ms = 800) => page.waitForTimeout(ms);

    // Two side threads, still running when the hero thread starts, so the sidebar shows parallel work.
    await startThreadFromSurface(page, {
      workspaceName: "field-notes",
      prompt:
        "Read every file in this repo, summarize what it does, and suggest three README improvements. Do not edit files.",
    });
    await startThreadFromSurface(page, {
      workspaceName: "tidy-cart",
      prompt:
        "Explain how cartTotal applies discounts and list edge cases worth testing. Do not edit files.",
    });
    const runningRows = page.locator('.session-row[data-sidebar-indicator="running"]');

    await page.locator(".sidebar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.locator(".new-thread__workspace").selectOption({ label: "tidy-cart" });
    stopRecording = startScreenRecording(rawVideo);
    await settle(1000);
    const prompt = page.getByLabel("New thread prompt", { exact: true });
    await prompt.click();
    await prompt.pressSequentially(HERO_PROMPT, { delay: 28 });
    await settle(600);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(send).toHaveAttribute("aria-label", "Stop run", { timeout: 30_000 });
    const heroId = await page.locator(".session-row--active").getAttribute("data-session-id");
    if (!heroId) throw new Error("Expected the hero thread to be selected");
    await expect(page.locator(".timeline-tool").first()).toBeVisible({ timeout: 60_000 });
    await settle(2500);
    await idle();
    await expect(runningRows).toHaveCount(0, { timeout: 240_000 });
    // A failed tool call makes a poor product shot; rerun the capture if the agent stumbled.
    await expect(page.locator(".timeline-tool--failed")).toHaveCount(0);
    await settle(1500);
    await openTool("Changes");
    const priceRow = workbench.locator('[data-file-path="src/price.js"]').first();
    await priceRow.click();
    // Widen the workbench so diffs read without wrapping.
    const resizeHandle = page.getByRole("separator", { name: "Side panel width" });
    await resizeHandle.focus();
    for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowLeft");
    await resizeHandle.blur();
    await expect(workbench.getByText("Combined changes")).toBeVisible();
    await settle(3500);
    await stopRecording();
    stopRecording = undefined;

    // Crops follow the widened workbench: the diff viewer for review, its top for the
    // terminal, and everything left of it for the thread list.
    const bench = await boxOf(workbench);
    const benchHeight = Math.min(bench.height, Math.round(bench.width * 0.8));
    const viewer = await boxOf(workbench.locator(".diff-panel__viewer"));
    const diffCrop = { ...bench, y: viewer.y, height: Math.min(viewer.height, benchHeight) };
    const terminalCrop = { ...bench, height: benchHeight };
    const threadsCrop = { x: 0, y: 0, width: bench.x, height: Math.round(bench.x * 0.625) };
    const paletteCrop = async () => {
      const box = await boxOf(page.getByTestId("command-palette"));
      return { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 };
    };
    await publishStill(page, runDir, "review-light", diffCrop);

    await openTool("Terminal");
    const terminal = page.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await settle(1500);
    await terminal.click();
    await page.keyboard.type("npm test\n", { delay: 30 });
    await expect(terminal).toContainText("pass 2", { timeout: 30_000 });
    await settle();
    await publishStill(page, runDir, "terminal-light", terminalCrop);

    await openTool("Changes");
    await page.locator(".timeline-item--assistant").last().click();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await settle();
    await publishStill(page, runDir, "palette-light", await paletteCrop());
    await page.keyboard.press("Escape");

    // More threads running beside the finished one, for the parallel-work shot.
    await startThreadFromSurface(page, {
      workspaceName: "tidy-cart",
      prompt: "Review test/price.test.js and list the cases it still misses. Do not edit files.",
    });
    await startThreadFromSurface(page, {
      workspaceName: "field-notes",
      prompt:
        "Read src/search.ts and suggest how to make search case-insensitive. Do not edit files.",
    });
    await page.locator(`.session-row[data-session-id="${heroId}"] .session-row__select`).click();
    await expect(workbench).toBeVisible();
    await expect(runningRows).toHaveCount(2);
    // Wait for generated titles so no row still reads "New thread".
    await expect(page.locator(".session-row__title", { hasText: /^New thread$/ })).toHaveCount(0, {
      timeout: 60_000,
    });
    // Park the pointer on the workbench, outside the crop, so no row shows its hover actions.
    await page.mouse.move(bench.x + bench.width / 2, bench.y + bench.height / 2);
    await settle(1200);
    await publishStill(page, runDir, "threads", threadsCrop);
    await expect(runningRows).toHaveCount(0, { timeout: 240_000 });

    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.locator(".settings-row", { hasText: "Dark" }).locator('input[type="radio"]').click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect(workbench).toBeVisible();
    await settle(1200);
    await publishStill(page, runDir, "review-dark", diffCrop);
    await openTool("Terminal");
    await settle();
    await publishStill(page, runDir, "terminal-dark", terminalCrop);
    await page.locator(".timeline-item--assistant").last().click();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await settle();
    await publishStill(page, runDir, "palette-dark", await paletteCrop());
    await page.keyboard.press("Escape");

    await publishVideo(rawVideo, "hero");
  } finally {
    await stopRecording?.();
    await harness.close();
    xvfb.kill();
    // Only the copied credentials go; the rest of the run is retained as evidence.
    await unlink(path.join(agentDir, "auth.json"));
    console.log(`Retained capture profile, workspaces and raw frames in ${runDir}`);
  }
});
