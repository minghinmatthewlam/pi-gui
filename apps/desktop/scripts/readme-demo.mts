import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  addWorkspaceViaIpc,
  createSessionViaIpc,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeWorkspace,
} from "../tests/helpers/electron-app.ts";

const execFileAsync = promisify(execFile);
const frameRate = 10;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const outputDir = path.join(repoRoot, "docs", "readme");

async function main(): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "pi-gui-demo-user-data-"));
  const framesDir = await mkdtemp(path.join(tmpdir(), "pi-gui-demo-frames-"));
  const workspacePath = await makeWorkspace("acme-web");

  await mkdir(outputDir, { recursive: true });

  const harness = await launchDesktop(userDataDir);
  let stopRecording: (() => Promise<number>) | undefined;

  try {
    const page = await harness.firstWindow();
    stopRecording = startFrameRecorder(page, framesDir);

    await hold(700);
    await addWorkspaceViaIpc(page, workspacePath);
    await hold(700);

    await createSessionViaIpc(page, workspacePath, "README demo");
    await hold(500);

    const prompt = [
      "Use your read tool to inspect README.md in this workspace.",
      "Then reply in exactly two short bullet points:",
      "- project name",
      "- one suggested next step",
    ].join(" ");

    const composer = page.getByTestId("composer");
    await composer.click();
    await composer.pressSequentially(prompt, { delay: 28 });
    await hold(600);
    await page.getByTestId("send").click();

    await waitForLiveResponse(page, {
      timeoutMs: 90_000,
      minimumAssistantLength: 30,
    });
    await hold(1200);

    await page.screenshot({ path: path.join(outputDir, "demo-poster.png") });

    const frameCount = await stopRecording();
    stopRecording = undefined;
    if (frameCount < 10) {
      throw new Error(`Expected at least 10 frames, captured ${frameCount}`);
    }

    await renderMp4(framesDir, path.join(outputDir, "demo.mp4"));
    await renderGif(framesDir, path.join(outputDir, "demo.gif"));

    const gifStats = await stat(path.join(outputDir, "demo.gif"));
    const mp4Stats = await stat(path.join(outputDir, "demo.mp4"));
    console.log(`Generated docs/readme/demo.gif (${formatMb(gifStats.size)})`);
    console.log(`Generated docs/readme/demo.mp4 (${formatMb(mp4Stats.size)})`);
    console.log("Generated docs/readme/demo-poster.png");
  } finally {
    try {
      if (stopRecording) {
        await stopRecording();
      }
    } catch {
      // best effort cleanup
    }
    await harness.close();
    await rm(userDataDir, { recursive: true, force: true });
    await rm(framesDir, { recursive: true, force: true });
  }
}

function startFrameRecorder(page: Page, framesDir: string): () => Promise<number> {
  let active = true;
  let frameIndex = 0;

  const loop = (async () => {
    while (active) {
      const filePath = path.join(framesDir, `frame-${String(frameIndex).padStart(5, "0")}.png`);
      await page.screenshot({ path: filePath });
      frameIndex += 1;
      await hold(1000 / frameRate);
    }
  })();

  return async () => {
    active = false;
    await loop;
    const frames = await readdir(framesDir);
    return frames.length;
  };
}

async function waitForLiveResponse(
  page: Page,
  options: {
    timeoutMs: number;
    minimumAssistantLength: number;
  },
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    const selectedTranscript = await getSelectedTranscript(page);
    const transcript =
      selectedTranscript?.workspaceId === workspace?.id &&
      selectedTranscript?.sessionId === session?.id
        ? (selectedTranscript?.transcript ?? [])
        : [];
    const assistantMessages = transcript.flatMap((item) =>
      item.kind === "message" && item.role === "assistant" ? [item.text] : [],
    );
    const latestAssistant = assistantMessages.at(-1);

    if (state.lastError) {
      throw new Error(`Live demo failed: ${state.lastError}`);
    }

    if (
      session?.status === "idle" &&
      latestAssistant &&
      latestAssistant.trim().length >= options.minimumAssistantLength
    ) {
      return;
    }

    await hold(250);
  }

  throw new Error(`Timed out waiting for live response after ${options.timeoutMs}ms`);
}

async function renderMp4(framesDir: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    path.join(framesDir, "frame-%05d.png"),
    "-vf",
    "scale=1280:-1:flags=lanczos,format=yuv420p",
    "-an",
    outputPath,
  ]);
}

async function renderGif(framesDir: string, outputPath: string): Promise<void> {
  const palettePath = path.join(framesDir, "palette.png");
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    path.join(framesDir, "frame-%05d.png"),
    "-frames:v",
    "1",
    "-vf",
    "fps=10,scale=960:-1:flags=lanczos,palettegen=stats_mode=single",
    palettePath,
  ]);

  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    path.join(framesDir, "frame-%05d.png"),
    "-i",
    palettePath,
    "-lavfi",
    "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5",
    outputPath,
  ]);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function hold(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
