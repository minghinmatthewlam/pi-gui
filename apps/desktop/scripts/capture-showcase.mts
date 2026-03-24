import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { addWorkspace, createSession, getDesktopState, launchDesktop, makeWorkspace, type PiAppWindow } from "../tests/harness.ts";

const execFileAsync = promisify(execFile);
// Each Retina screenshot takes ~200ms, so effective capture rate is ~5fps.
// Tell ffmpeg the same rate so playback duration matches real capture duration.
const frameRate = 5;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const capturesDir = path.join(repoRoot, "video", "public", "captures");

// ---------------------------------------------------------------------------
// Frame recording utilities (adapted from readme-demo.mts)
// ---------------------------------------------------------------------------

function startFrameRecorder(page: Page, framesDir: string): () => Promise<number> {
  let active = true;
  let frameIndex = 0;

  const loop = (async () => {
    while (active) {
      try {
        const filePath = path.join(framesDir, `frame-${String(frameIndex).padStart(5, "0")}.png`);
        await page.screenshot({ path: filePath });
        frameIndex += 1;
        // No inter-frame delay — screenshot itself takes ~200ms on Retina,
        // so effective rate is ~5fps which matches our frameRate setting.
      } catch {
        // Page closed or browser crashed — stop gracefully
        active = false;
      }
    }
  })();

  return async () => {
    active = false;
    await loop;
    const frames = await readdir(framesDir);
    return frames.length;
  };
}

async function renderClip(framesDir: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate", String(frameRate),
    "-i", path.join(framesDir, "frame-%05d.png"),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-c:v", "libx264",
    "-crf", "18",
    "-an",
    outputPath,
  ]);
}

function hold(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLiveResponse(
  page: Page,
  options: { timeoutMs: number; minimumAssistantLength: number },
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    const transcript = session?.transcript ?? [];
    const assistantMessages = transcript.filter((item) => item.kind === "message" && item.role === "assistant");
    const latestAssistant = assistantMessages.at(-1);

    if (state.lastError) {
      throw new Error(`Capture failed: ${state.lastError}`);
    }

    if (
      session?.status === "idle" &&
      latestAssistant &&
      latestAssistant.text.trim().length >= options.minimumAssistantLength
    ) {
      return;
    }
    await hold(250);
  }
  throw new Error(`Timed out waiting for response after ${options.timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Clip capture functions
// ---------------------------------------------------------------------------

async function captureParallelSessions(page: Page): Promise<void> {
  console.log("  Capturing parallel sessions...");
  const framesDir = await mkdtemp(path.join(tmpdir(), "pi-capture-parallel-"));

  // Create two sessions via IPC (workspace already added by main)
  const workspaceId = await page.evaluate(async () => {
    const app = (window as PiAppWindow).piApp;
    if (!app) throw new Error("piApp unavailable");
    const state = await app.getState();
    const workspace = state.workspaces[0];
    if (!workspace) throw new Error("Expected workspace");
    await app.createSession({ workspaceId: workspace.id, title: "Backend refactor" });
    await app.createSession({ workspaceId: workspace.id, title: "Fix login bug" });
    return workspace.id;
  });

  await hold(600);

  // Wait for both sessions to appear
  let sessionAId = "";
  let sessionBId = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await getDesktopState(page);
    const ws = state.workspaces.find((w) => w.id === workspaceId);
    const a = ws?.sessions.find((s) => s.title === "Backend refactor");
    const b = ws?.sessions.find((s) => s.title === "Fix login bug");
    if (a && b) {
      sessionAId = a.id;
      sessionBId = b.id;
      break;
    }
    await hold(200);
  }

  // Start recording
  const stopRecording = startFrameRecorder(page, framesDir);

  try {
    await hold(800);

    // Fire prompt in session A
    const promptA = "Analyze the project structure and suggest three architectural improvements. Be concise.";
    await page.evaluate(({ workspaceId: wId, sessionId, prompt }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId: wId, sessionId }).then(() => app.submitComposer(prompt));
    }, { workspaceId, sessionId: sessionAId, prompt: promptA });

    // Wait until A is running
    const aRunDeadline = Date.now() + 30_000;
    while (Date.now() < aRunDeadline) {
      const state = await getDesktopState(page);
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (ws?.sessions.find((s) => s.id === sessionAId)?.status === "running") break;
      await hold(200);
    }

    // Let session A stream briefly
    await hold(2000);

    // Fire prompt in session B
    const promptB = "List the top 5 files in this project by importance. One sentence each.";
    await page.evaluate(({ workspaceId: wId, sessionId, prompt }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId: wId, sessionId }).then(() => app.submitComposer(prompt));
    }, { workspaceId, sessionId: sessionBId, prompt: promptB });

    // Let B stream while visible
    await hold(2500);

    // Switch back to session A to show both running
    await page.evaluate(({ workspaceId: wId, sessionId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId: wId, sessionId });
    }, { workspaceId, sessionId: sessionAId });

    // Show A's progress
    await hold(2500);

    // Switch to B
    await page.evaluate(({ workspaceId: wId, sessionId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId: wId, sessionId });
    }, { workspaceId, sessionId: sessionBId });

    // Hold on B
    await hold(2000);
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    await renderClip(framesDir, path.join(capturesDir, "parallel-sessions.mp4"));
    await rm(framesDir, { recursive: true, force: true });
  }
}

async function captureSlashCommands(page: Page): Promise<void> {
  console.log("  Capturing slash commands...");
  const framesDir = await mkdtemp(path.join(tmpdir(), "pi-capture-slash-"));

  // Create a session so the composer is visible
  await page.evaluate(async () => {
    const app = (window as PiAppWindow).piApp;
    if (!app) throw new Error("piApp unavailable");
    const state = await app.getState();
    const workspace = state.workspaces[0];
    if (!workspace) throw new Error("Expected workspace");
    await app.createSession({ workspaceId: workspace.id, title: "Slash command demo" });
  });
  await hold(1200);

  // Wait for the composer to be visible
  await page.waitForSelector('[data-testid="composer"]', { state: "visible", timeout: 10_000 });

  const stopRecording = startFrameRecorder(page, framesDir);
  try {
    await hold(600);

    // Type / in composer to trigger slash menu
    const composer = page.getByTestId("composer");
    await composer.click({ timeout: 5_000 });
    await composer.fill("");
    await hold(400);
    await composer.pressSequentially("/", { delay: 120 });
    await hold(2500);

    // Navigate down through menu items
    await page.keyboard.press("ArrowDown");
    await hold(500);
    await page.keyboard.press("ArrowDown");
    await hold(500);
    await page.keyboard.press("ArrowDown");
    await hold(500);

    // Type /model to show provider list
    await composer.fill("");
    await hold(300);
    await composer.pressSequentially("/model", { delay: 100 });
    await hold(2500);

    // Clear and dismiss
    await composer.fill("");
    await hold(400);
    await page.keyboard.press("Escape");
    await hold(500);
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    await renderClip(framesDir, path.join(capturesDir, "slash-commands.mp4"));
    await rm(framesDir, { recursive: true, force: true });
  }
}

async function captureSkillsSettings(page: Page): Promise<void> {
  console.log("  Capturing skills & settings...");
  const framesDir = await mkdtemp(path.join(tmpdir(), "pi-capture-skills-"));

  const stopRecording = startFrameRecorder(page, framesDir);
  try {
    await hold(600);

    // Navigate to Skills view via IPC
    await page.evaluate(() => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      return app.setActiveView("skills");
    });
    await hold(3000);

    // Navigate to Settings via IPC
    await page.evaluate(() => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      return app.setActiveView("settings");
    });
    await hold(3000);
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    await renderClip(framesDir, path.join(capturesDir, "skills-settings.mp4"));
    await rm(framesDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Launch a fresh Electron instance, add workspace, run capture, then close. */
async function withFreshApp(
  workspacePath: string,
  capture: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "pi-app-showcase-"));
  // Launch without initial workspaces — matches readme-demo.mts pattern
  const harness = await launchDesktop(userDataDir);
  try {
    const page = await harness.firstWindow();
    // Bring window to front
    await page.evaluate(() => window.focus());
    await hold(700);
    await addWorkspace(page, workspacePath);
    await hold(700);

    // Verify the app actually rendered
    await page.waitForSelector(".shell", { state: "visible", timeout: 15_000 });
    console.log("  App rendered successfully");

    await capture(page);
  } finally {
    await harness.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("Pi Desktop Showcase Capture");
  console.log("==========================\n");

  await mkdir(capturesDir, { recursive: true });

  // Create a workspace with demo skills so the Skills view has content
  const workspacePath = await makeWorkspace("demo-project");
  await mkdir(path.join(workspacePath, ".agents", "skills", "code-review"), { recursive: true });
  await writeFile(
    path.join(workspacePath, ".agents", "skills", "code-review", "SKILL.md"),
    `# Code Review\n\nReview the latest changes and provide feedback on code quality, security, and performance.\n\n## Workflow\n\n1. Identify changed files.\n2. Analyze each change.\n3. Provide structured feedback.\n`,
    "utf8",
  );
  await mkdir(path.join(workspacePath, ".agents", "skills", "test-writer"), { recursive: true });
  await writeFile(
    path.join(workspacePath, ".agents", "skills", "test-writer", "SKILL.md"),
    `# Test Writer\n\nGenerate unit and integration tests for recently modified code.\n\n## Workflow\n\n1. Find untested functions.\n2. Generate test cases.\n3. Validate coverage.\n`,
    "utf8",
  );

  console.log("Clip 1/3: Parallel Sessions");
  await withFreshApp(workspacePath, captureParallelSessions);
  console.log("  Done.\n");

  console.log("Clip 2/3: Slash Commands");
  await withFreshApp(workspacePath, captureSlashCommands);
  console.log("  Done.\n");

  console.log("Clip 3/3: Skills & Settings");
  await withFreshApp(workspacePath, captureSkillsSettings);
  console.log("  Done.\n");

  console.log("All clips captured to video/public/captures/");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
