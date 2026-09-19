import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  addWorkspaceViaIpc,
  getDesktopState,
  launchDesktop,
  makeWorkspace,
  type PiAppWindow,
} from "../tests/helpers/electron-app.ts";
import { replaceFileAtomically } from "./atomic-output.mts";

const execFileAsync = promisify(execFile);
// Each Retina screenshot takes ~200ms, so effective capture rate is ~5fps.
// Tell ffmpeg the same rate so playback duration matches real capture duration.
const frameRate = 5;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const publishingRoot = process.env.PI_GUI_MARKETING_STAGE_DIR
  ? path.resolve(process.env.PI_GUI_MARKETING_STAGE_DIR)
  : repoRoot;
const capturesDir = path.join(publishingRoot, "video", "public", "captures");
const evidenceRoot = path.join(repoRoot, ".artifacts", "marketing", "showcase-captures");

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
  await replaceFileAtomically(outputPath, async (temporaryOutputPath) => {
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      String(frameRate),
      "-i",
      path.join(framesDir, "frame-%05d.png"),
      "-vf",
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-an",
      temporaryOutputPath,
    ]);
  });
}

function hold(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Clip capture functions
// ---------------------------------------------------------------------------

async function captureParallelSessions(
  page: Page,
  evidenceDir: string,
  model: { readonly provider: string; readonly modelId: string },
): Promise<void> {
  console.log("  Capturing parallel sessions...");
  const framesDir = path.join(evidenceDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const started = await page.evaluate(
    async ({ nextProvider, nextModelId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      const initialState = await app.getState();
      const workspace = initialState.workspaces[0];
      if (!workspace) throw new Error("Expected workspace");
      const rootWorkspaceId = workspace.rootWorkspaceId ?? workspace.id;
      const firstState = await app.startThread({
        rootWorkspaceId,
        environment: "local",
        prompt:
          "Analyze the project structure and suggest three architectural improvements. Be concise.",
        provider: nextProvider,
        modelId: nextModelId,
      });
      const firstSessionId = firstState.selectedSessionId;
      if (!firstSessionId) throw new Error("First showcase thread did not return a session ID");
      const secondState = await app.startThread({
        rootWorkspaceId,
        environment: "local",
        prompt: "List the top 5 files in this project by importance. One sentence each.",
        provider: nextProvider,
        modelId: nextModelId,
      });
      const secondSessionId = secondState.selectedSessionId;
      if (!secondSessionId) throw new Error("Second showcase thread did not return a session ID");
      return { workspaceId: workspace.id, firstSessionId, secondSessionId };
    },
    { nextProvider: model.provider, nextModelId: model.modelId },
  );

  let bothRunning = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((entry) => entry.id === started.workspaceId);
    const first = workspace?.sessions.find((session) => session.id === started.firstSessionId);
    const second = workspace?.sessions.find((session) => session.id === started.secondSessionId);
    if (first?.status === "running" && second?.status === "running") {
      bothRunning = true;
      break;
    }
    await hold(200);
  }
  if (!bothRunning) {
    throw new Error("Both showcase sessions did not reach running state before recording");
  }

  const stopRecording = startFrameRecorder(page, framesDir);
  let captureSucceeded = false;

  try {
    await hold(800);
    await page.evaluate(
      ({ workspaceId: wId, sessionId }) => {
        const app = (window as PiAppWindow).piApp;
        if (!app) throw new Error("piApp unavailable");
        return app.selectSession({ workspaceId: wId, sessionId });
      },
      { workspaceId: started.workspaceId, sessionId: started.firstSessionId },
    );
    await hold(2500);
    await page.evaluate(
      ({ workspaceId: wId, sessionId }) => {
        const app = (window as PiAppWindow).piApp;
        if (!app) throw new Error("piApp unavailable");
        return app.selectSession({ workspaceId: wId, sessionId });
      },
      { workspaceId: started.workspaceId, sessionId: started.secondSessionId },
    );
    await hold(2000);
    await page.evaluate(async ({ workspaceId: wId, firstSessionId, secondSessionId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      await app.selectSession({ workspaceId: wId, sessionId: firstSessionId });
      await app.cancelCurrentRun();
      await app.selectSession({ workspaceId: wId, sessionId: secondSessionId });
      await app.cancelCurrentRun();
    }, started);
    captureSucceeded = true;
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    if (captureSucceeded) {
      await renderClip(framesDir, path.join(capturesDir, "parallel-sessions.mp4"));
    }
    console.log(`  Retained frames in ${framesDir}`);
  }
}

async function captureSlashCommands(page: Page, evidenceDir: string): Promise<void> {
  console.log("  Capturing slash commands...");
  const framesDir = path.join(evidenceDir, "frames");
  await mkdir(framesDir, { recursive: true });

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
  let captureSucceeded = false;
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
    captureSucceeded = true;
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    if (captureSucceeded) {
      await renderClip(framesDir, path.join(capturesDir, "slash-commands.mp4"));
    }
    console.log(`  Retained frames in ${framesDir}`);
  }
}

async function captureSkillsSettings(page: Page, evidenceDir: string): Promise<void> {
  console.log("  Capturing skills & settings...");
  const framesDir = path.join(evidenceDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const stopRecording = startFrameRecorder(page, framesDir);
  let captureSucceeded = false;
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
    captureSucceeded = true;
  } finally {
    const frameCount = await stopRecording();
    console.log(`  Captured ${frameCount} frames`);
    if (captureSucceeded) {
      await renderClip(framesDir, path.join(capturesDir, "skills-settings.mp4"));
    }
    console.log(`  Retained frames in ${framesDir}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Launch a fresh Electron instance, add workspace, run capture, then close. */
async function withFreshApp(
  workspacePath: string,
  evidenceDir: string,
  provider: string,
  modelId: string,
  capture: (
    page: Page,
    evidenceDir: string,
    model: { readonly provider: string; readonly modelId: string },
  ) => Promise<void>,
): Promise<void> {
  const userDataDir = path.join(evidenceDir, "user-data");
  const agentDir = path.join(userDataDir, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: provider,
        defaultModel: modelId,
        defaultThinkingLevel: "medium",
        enabledModels: [`${provider}/${modelId}`],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  // Launch without initial workspaces — matches readme-demo.mts pattern
  const harness = await launchDesktop(userDataDir, { agentDir });
  try {
    const page = await harness.firstWindow();
    // Bring window to front
    await page.evaluate(() => window.focus());
    await hold(700);
    await addWorkspaceViaIpc(page, workspacePath);
    await hold(700);

    // Verify the app actually rendered
    await page.waitForSelector(".shell", { state: "visible", timeout: 15_000 });
    console.log("  App rendered successfully");

    await capture(page, evidenceDir, { provider, modelId });
  } finally {
    await harness.close();
    console.log(`  Retained synthetic profile and frames in ${evidenceDir}`);
  }
}

async function main(): Promise<void> {
  if (process.env.PI_GUI_MARKETING_ALLOW_PROVIDER_ENV !== "1") {
    throw new Error(
      "Showcase capture submits real prompts. Set PI_GUI_MARKETING_ALLOW_PROVIDER_ENV=1 plus PI_GUI_MARKETING_PROVIDER and PI_GUI_MARKETING_MODEL to opt in to provider environment variables.",
    );
  }
  const provider = process.env.PI_GUI_MARKETING_PROVIDER?.trim();
  const modelId = process.env.PI_GUI_MARKETING_MODEL?.trim();
  if (!provider || !modelId) {
    throw new Error(
      "PI_GUI_MARKETING_PROVIDER and PI_GUI_MARKETING_MODEL are required for showcase capture.",
    );
  }

  console.log("Pi Desktop Showcase Capture");
  console.log("==========================\n");

  await mkdir(capturesDir, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(evidenceRoot, "run-"));

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
  await withFreshApp(
    workspacePath,
    await mkdtemp(path.join(runDir, "parallel-")),
    provider,
    modelId,
    captureParallelSessions,
  );
  console.log("  Done.\n");

  console.log("Clip 2/3: Slash Commands");
  await withFreshApp(
    workspacePath,
    await mkdtemp(path.join(runDir, "slash-")),
    provider,
    modelId,
    captureSlashCommands,
  );
  console.log("  Done.\n");

  console.log("Clip 3/3: Skills & Settings");
  await withFreshApp(
    workspacePath,
    await mkdtemp(path.join(runDir, "skills-")),
    provider,
    modelId,
    captureSkillsSettings,
  );
  console.log("  Done.\n");

  console.log("All clips captured to video/public/captures/");
  console.log(`Retained capture profiles and frames in ${runDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
