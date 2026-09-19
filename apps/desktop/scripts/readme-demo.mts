import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  addWorkspaceViaIpc,
  createSessionViaIpc,
  launchDesktop,
  makeWorkspace,
  streamAssistantDeltas,
} from "../tests/helpers/electron-app.ts";
import { replaceFileAtomically } from "./atomic-output.mts";

const execFileAsync = promisify(execFile);
const frameRate = 10;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const publishingRoot = process.env.PI_GUI_MARKETING_STAGE_DIR
  ? path.resolve(process.env.PI_GUI_MARKETING_STAGE_DIR)
  : repoRoot;
const outputDir = path.join(publishingRoot, "docs", "assets");
const websiteDemoPath = path.join(publishingRoot, "apps", "website", "public", "demo.mp4");
const evidenceRoot = path.join(repoRoot, ".artifacts", "marketing", "readme-demo");

async function main(): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(evidenceRoot, "run-"));
  const userDataDir = path.join(runDir, "user-data");
  const framesDir = path.join(runDir, "frames");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(framesDir, { recursive: true });
  const workspacePath = await makeWorkspace("acme-web");

  await mkdir(outputDir, { recursive: true });
  await mkdir(path.dirname(websiteDemoPath), { recursive: true });

  const harness = await launchDesktop(userDataDir, { scrubProviderEnv: true });
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
    await composer.fill("");
    await streamAssistantDeltas(harness, page, [
      "- project name: pi-gui\n",
      "- suggested next step: run the focused desktop verification lane",
    ]);
    await hold(1200);

    await page.screenshot({ path: path.join(runDir, "demo-poster.png") });

    const frameCount = await stopRecording();
    stopRecording = undefined;
    if (frameCount < 10) {
      throw new Error(`Expected at least 10 frames, captured ${frameCount}`);
    }

    await renderMp4(framesDir, path.join(outputDir, "demo.mp4"));
    await renderGif(framesDir, path.join(outputDir, "demo.gif"));
    await publishCopy(path.join(outputDir, "demo.mp4"), websiteDemoPath);

    const gifStats = await stat(path.join(outputDir, "demo.gif"));
    const mp4Stats = await stat(path.join(outputDir, "demo.mp4"));
    console.log(`Generated docs/assets/demo.gif (${formatMb(gifStats.size)})`);
    console.log(`Generated docs/assets/demo.mp4 (${formatMb(mp4Stats.size)})`);
    console.log("Updated apps/website/public/demo.mp4 from the new capture");
  } finally {
    try {
      if (stopRecording) {
        await stopRecording();
      }
    } catch {
      // Preserve partial frames even when recording stops with an error.
    }
    await harness.close();
    console.log(`Retained capture profile and frames in ${runDir}`);
    console.log(`Retained demo workspace at ${workspacePath}`);
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

async function renderMp4(framesDir: string, outputPath: string): Promise<void> {
  await replaceFileAtomically(outputPath, async (temporaryOutputPath) => {
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      String(frameRate),
      "-i",
      path.join(framesDir, "frame-%05d.png"),
      "-vf",
      "scale=1280:-2:flags=lanczos,format=yuv420p",
      "-an",
      temporaryOutputPath,
    ]);
  });
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

  await replaceFileAtomically(outputPath, async (temporaryOutputPath) => {
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
      temporaryOutputPath,
    ]);
  });
}

async function publishCopy(sourcePath: string, outputPath: string): Promise<void> {
  await replaceFileAtomically(outputPath, (temporaryOutputPath) =>
    copyFile(sourcePath, temporaryOutputPath),
  );
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
