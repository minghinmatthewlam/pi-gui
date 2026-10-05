import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { PiDesktopApi } from "../../contracts/ipc";
import type {
  DesktopAppState,
  NewThreadEnvironment,
  SelectedTranscriptRecord,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import { resolvePackagedAppExecutable } from "./packaged-app";
import { TINY_PNG_BASE64 } from "./native-input";
import {
  desktopTestTarget,
  type DesktopHarness,
  type RuntimeToolTestInput,
  type RuntimeToolTestResult,
} from "./desktop-harness";
import { launchTestHost } from "./testhost";
import { createElectronHarness, type ElectronDesktopHarness } from "./electron-harness";

export {
  copyAppBundle,
  extractAppBundleFromReleaseZip,
  extractPackagedReleaseZipAppBundle,
  resolveAppBundleExecutable,
  resolvePackagedAppBundle,
  resolvePackagedAppExecutable,
  resolvePackagedReleaseZip,
} from "./packaged-app";
export * from "./native-input";
export type { DesktopHarness } from "./desktop-harness";
export { HYDRATE_TEST_SENTINEL } from "./desktop-harness";
export type { ElectronDesktopHarness } from "./electron-harness";

const desktopDir = resolve(__dirname, "..", "..");
const execFileAsync = promisify(execFile);
const require = createRequire(__filename);
const electronExecutablePath = require("electron") as string;
const REAL_AUTH_ENV_VAR = "PI_APP_REAL_AUTH";
const REAL_AUTH_SOURCE_DIR_ENV_VAR = "PI_APP_REAL_AUTH_SOURCE_DIR";
const REQUIRED_REAL_AUTH_FILES = ["auth.json"] as const;
const OPTIONAL_REAL_AUTH_FILES = ["settings.json", "models.json"] as const;
// Provider auth env vars the pi runtime honors that do NOT end in `_API_KEY`
// (see the runtime's `Environment Variables` help block). Every `*_API_KEY`
// var is scrubbed dynamically below, so this only needs the exceptions.
const NON_API_KEY_PROVIDER_ENV_VARS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
] as const;

// Any ambient provider credential connects a provider in the isolated runtime,
// which silently poisons "no providers connected" assertions on developer
// machines that export keys the hardcoded list happened to miss. Scrub the full
// class instead: every `*_API_KEY` var plus the documented non-suffixed ones.
function isProviderAuthEnvVar(key: string): boolean {
  return (
    key.endsWith("_API_KEY") || (NON_API_KEY_PROVIDER_ENV_VARS as readonly string[]).includes(key)
  );
}
export type PiAppWindow = Window & { piApp?: PiDesktopApi };
export type DesktopTestMode = "foreground" | "background";

export interface LaunchDesktopOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly notificationLogPath?: string;
  readonly testMode?: DesktopTestMode;
  readonly agentDir?: string;
  readonly realAuthSourceDir?: string;
  readonly enabledModels?: readonly string[];
  readonly scrubProviderEnv?: boolean;
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
  readonly inheritParentEnv?: boolean;
  readonly recordVideoDir?: string;
  readonly recordVideoSize?: { readonly width: number; readonly height: number };
}

export interface SeedAgentDirOptions {
  readonly withOpenAiAuth?: boolean;
  readonly withDefaultModel?: boolean;
  readonly enabledModels?: readonly string[];
}

export interface RealAuthConfig {
  readonly enabled: boolean;
  readonly sourceDir?: string;
  readonly skipReason?: string;
}

export function getRealAuthConfig(): RealAuthConfig {
  if (process.env[REAL_AUTH_ENV_VAR] !== "1") {
    return {
      enabled: false,
      skipReason: `Set ${REAL_AUTH_ENV_VAR}=1 and ${REAL_AUTH_SOURCE_DIR_ENV_VAR}=/absolute/path/to/agent to run this spec.`,
    };
  }

  const sourceDir = process.env[REAL_AUTH_SOURCE_DIR_ENV_VAR]?.trim();
  if (!sourceDir) {
    return {
      enabled: false,
      skipReason: `Set ${REAL_AUTH_SOURCE_DIR_ENV_VAR}=/absolute/path/to/agent when ${REAL_AUTH_ENV_VAR}=1.`,
    };
  }

  return {
    enabled: true,
    sourceDir: resolve(sourceDir),
  };
}

function isWorkspacePaths(
  options: readonly string[] | LaunchDesktopOptions,
): options is readonly string[] {
  return Array.isArray(options);
}

function normalizeLaunchOptions(
  options: readonly string[] | LaunchDesktopOptions,
): LaunchDesktopOptions {
  return isWorkspacePaths(options) ? { initialWorkspaces: options } : options;
}

function electronCliArgs(entry?: string): string[] {
  const args = entry ? [entry] : [];
  if (process.platform === "linux") {
    // A never-shown X11 window draws ~1.5 frames/s, which starves rAF-driven layout
    // and native wheel scrolling in background test mode.
    args.push("--disable-gpu", "--no-sandbox", "--disable-frame-rate-limit");
  }
  return args;
}

/** Launches the app the specs target (`PI_APP_TEST_TARGET`, Electron by default). */
export async function launchDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<DesktopHarness> {
  if (desktopTestTarget() === "testhost") {
    return launchTestHost(userDataDir, normalizeLaunchOptions(options));
  }
  return launchElectronDesktop(userDataDir, options);
}

/** For suites that only make sense on Electron (perf, product media, Electron verification). */
export async function launchElectronDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<ElectronDesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  // Playwright's Electron video recorder can stall loadURL on Linux, leaving a
  // placeholder BrowserWindow whose URL never leaves empty. Skip it there;
  // callers still capture screenshots and traces.
  const recordVideo =
    normalized.recordVideoDir && process.platform !== "linux"
      ? {
          recordVideo: {
            dir: normalized.recordVideoDir,
            ...(normalized.recordVideoSize ? { size: normalized.recordVideoSize } : {}),
          },
        }
      : {};
  const electronApp = await electron.launch({
    args: electronCliArgs(desktopDir),
    cwd: desktopDir,
    env,
    ...recordVideo,
  });

  return createElectronHarness(electronApp);
}

export async function spawnDesktopProcess(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<ChildProcess> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  return spawn(electronExecutablePath, electronCliArgs(desktopDir), {
    cwd: desktopDir,
    env,
    stdio: "ignore",
  });
}

export async function launchPackagedDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<ElectronDesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  const releaseDir = resolvePackagedReleaseDir(process.env.PI_APP_TEST_RELEASE_DIR);
  const executablePath = await resolvePackagedAppExecutable(releaseDir);
  return launchDesktopExecutable(executablePath, env);
}

export async function launchDesktopByExecutable(
  executablePath: string,
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<ElectronDesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  return launchDesktopExecutable(executablePath, env);
}

async function launchDesktopExecutable(
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<ElectronDesktopHarness> {
  const electronApp = await electron.launch({
    executablePath,
    args: electronCliArgs(),
    cwd: dirname(executablePath),
    env,
  });

  return createElectronHarness(electronApp);
}

function buildDesktopLaunchEnv(
  userDataDir: string,
  agentDir: string,
  options: LaunchDesktopOptions,
): NodeJS.ProcessEnv {
  const baseEnv = options.inheritParentEnv === false ? {} : { ...process.env };
  // Ambient provider credentials must never turn a fixture test into a real request.
  // Explicit envOverrides remain available for tests of environment configuration.
  for (const key of Object.keys(baseEnv)) {
    if (isProviderAuthEnvVar(key)) delete baseEnv[key];
  }
  const env = {
    ...baseEnv,
    PI_APP_USER_DATA_DIR: userDataDir,
    PI_APP_INITIAL_WORKSPACES: (options.initialWorkspaces ?? []).join(delimiter),
    PI_APP_TEST_MODE: options.testMode ?? process.env.PI_APP_TEST_MODE ?? "foreground",
    PI_CODING_AGENT_DIR: agentDir,
    ...(options.notificationLogPath
      ? { PI_APP_NOTIFICATION_LOG_PATH: options.notificationLogPath }
      : {}),
    PI_APP_OPEN_DEVTOOLS: "0",
    ...(options.envOverrides ?? {}),
  };
  for (const [key, value] of Object.entries(options.envOverrides ?? {})) {
    if (value === undefined) {
      delete env[key];
    }
  }

  if (options.scrubProviderEnv || options.realAuthSourceDir) {
    for (const key of Object.keys(env)) {
      if (isProviderAuthEnvVar(key)) {
        delete env[key];
      }
    }
  }

  return env;
}

function resolvePackagedReleaseDir(rawPath: string | undefined): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolve(desktopDir, trimmed);
}

async function prepareAgentDir(
  userDataDir: string,
  options: LaunchDesktopOptions,
): Promise<string> {
  if (process.env.PI_APP_TEST_LANE === "core" && options.realAuthSourceDir) {
    throw new Error("Core tests must not use real provider credentials; use the live lane.");
  }
  if (options.agentDir && options.realAuthSourceDir) {
    throw new Error(
      "Pass either agentDir or realAuthSourceDir to the desktop launch helper, not both.",
    );
  }

  if (options.agentDir) {
    return options.agentDir;
  }

  const agentDir = join(userDataDir, "agent");
  if (options.realAuthSourceDir) {
    await seedAgentDirFromRealAuth(agentDir, options.realAuthSourceDir);
    await writeAgentEnabledModels(agentDir, options.enabledModels);
    return agentDir;
  }

  await seedAgentDir(agentDir, { enabledModels: options.enabledModels });
  return agentDir;
}

async function seedAgentDirFromRealAuth(agentDir: string, sourceDir: string): Promise<void> {
  const resolvedSourceDir = resolve(sourceDir);
  await mkdir(agentDir, { recursive: true });

  for (const fileName of REQUIRED_REAL_AUTH_FILES) {
    await copyAgentFile(resolvedSourceDir, agentDir, fileName, true);
  }

  for (const fileName of OPTIONAL_REAL_AUTH_FILES) {
    await copyAgentFile(resolvedSourceDir, agentDir, fileName, false);
  }
}

async function copyAgentFile(
  sourceDir: string,
  targetDir: string,
  fileName: string,
  required: boolean,
): Promise<void> {
  const sourcePath = join(sourceDir, fileName);
  try {
    await copyFile(sourcePath, join(targetDir, fileName));
  } catch (error) {
    if (required && isMissingPathError(error)) {
      throw new Error(
        `Real-auth source dir is missing required file ${fileName}: ${sourcePath}. ` +
          `Set ${REAL_AUTH_SOURCE_DIR_ENV_VAR} to an agent dir with the full provider state.`,
      );
    }

    if (!required && isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

async function writeAgentEnabledModels(
  agentDir: string,
  enabledModels: readonly string[] | undefined,
): Promise<void> {
  if (!enabledModels) {
    return;
  }

  const settingsPath = join(agentDir, "settings.json");
  const existingSettings = await readJsonObject(settingsPath);
  const firstModel = enabledModels[0];
  const defaultSelection = firstModel ? splitModelPattern(firstModel) : undefined;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...existingSettings,
        ...(defaultSelection
          ? {
              defaultProvider: defaultSelection.provider,
              defaultModel: defaultSelection.modelId,
            }
          : {}),
        enabledModels: [...enabledModels],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch (error) {
    if (isMissingPathError(error)) {
      return {};
    }
    throw error;
  }
}

function splitModelPattern(pattern: string): { provider: string; modelId: string } | undefined {
  const separatorIndex = pattern.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= pattern.length - 1) {
    return undefined;
  }
  return {
    provider: pattern.slice(0, separatorIndex),
    modelId: pattern.slice(separatorIndex + 1),
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function makeUserDataDir(prefix = "pi-gui-user-data-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function seedAgentDir(
  agentDir: string,
  options: SeedAgentDirOptions = {},
): Promise<void> {
  const {
    withOpenAiAuth = true,
    withDefaultModel = true,
    enabledModels = ["openai/gpt-5", "openai/gpt-4o"],
  } = options;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify(
      withOpenAiAuth
        ? {
            openai: { type: "api_key", key: "test-openai-key" },
          }
        : {},
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        ...(withDefaultModel ? { defaultProvider: "openai", defaultModel: "gpt-5" } : {}),
        defaultThinkingLevel: "medium",
        enabledModels,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function seedBranchedTreeSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "Tree fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendModelChange(provider: string, modelId: string): string;
        appendSessionInfo(name: string): string;
        appendThinkingLevelChange(thinkingLevel: string): string;
        branch(entryId: string): void;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    const appendUser = (content: string) =>
      sessionManager.appendMessage({
        role: "user",
        content,
        timestamp: nextTimestamp(),
      });
    const appendAssistant = (content: string) =>
      sessionManager.appendMessage({
        role: "assistant",
        content,
        timestamp: nextTimestamp(),
      });

    sessionManager.appendModelChange("openai", "gpt-5.4");
    sessionManager.appendThinkingLevelChange("high");
    appendUser("Root question");
    const rootAnswerId = appendAssistant("Root answer");
    appendUser("Branch alpha");
    appendAssistant("Alpha answer");

    sessionManager.branch(rootAnswerId);
    appendUser("Branch beta");
    const betaAnswerId = appendAssistant("Beta answer");
    appendUser("Beta detail one");
    appendAssistant("Beta detail answer one");
    appendUser("Beta detail two");
    appendAssistant("Beta detail answer two");
    for (let index = 3; index <= 40; index += 1) {
      appendUser(`Beta detail ${index}`);
      appendAssistant(`Beta detail answer ${index}`);
    }

    sessionManager.branch(betaAnswerId);
    sessionManager.appendSessionInfo("Tree fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Tree fixture session",
    };
  });
}

/**
 * A long compacted-style session shaped like a real user report: 11 branches, each forking
 * off the previous one, about 3,450 entries, and a deepest root-to-leaf path of 518 entries.
 */
export async function seedLargeBranchedTreeSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "Large tree fixture session";
  readonly entryCount: number;
  readonly deepestPath: number;
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendSessionInfo(name: string): string;
        branch(entryId: string): void;
        getSessionId(): string;
      };
    };
  };

  // [root-to-leaf length, depth on the previous branch where this one forks off]
  const branches: readonly (readonly [number, number])[] = [
    [164, 0],
    [518, 18],
    [372, 22],
    [433, 26],
    [448, 30],
    [378, 34],
    [367, 38],
    [325, 42],
    [290, 46],
    [471, 50],
    [58, 54],
  ];

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    let entryCount = 0;
    let previousPath: string[] = [];
    for (const [length, forkDepth] of branches) {
      const path = previousPath.slice(0, forkDepth);
      const forkId = path.at(-1);
      if (forkId) {
        sessionManager.branch(forkId);
      }
      while (path.length < length) {
        const index = path.length;
        timestamp += 1_000;
        path.push(
          sessionManager.appendMessage({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `Step ${index} on branch ${length}`,
            timestamp,
          }),
        );
        entryCount += 1;
      }
      previousPath = path;
    }
    sessionManager.appendSessionInfo("Large tree fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Large tree fixture session",
      entryCount,
      deepestPath: Math.max(...branches.map(([length]) => length)),
    };
  });
}

export async function seedExternalLinkSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "External link fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };

    sessionManager.appendMessage({
      role: "user",
      content: "Show me the related issue.",
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content:
        "Track this in [GitHub issue](https://github.com/minghinmatthewlam/pi-gui/issues/20). Ignore [email fallback](mailto:test@example.com).",
      timestamp: nextTimestamp(),
    });
    sessionManager.appendSessionInfo("External link fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "External link fixture session",
    };
  });
}

export async function seedNamedTextSessionFixture(
  agentDir: string,
  workspacePath: string,
  session: {
    readonly title: string;
    readonly userText: string;
    readonly assistantText: string;
  },
): Promise<{
  readonly sessionId: string;
  readonly title: string;
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    sessionManager.appendMessage({
      role: "user",
      content: session.userText,
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: session.assistantText,
      timestamp: nextTimestamp(),
    });
    sessionManager.appendSessionInfo(session.title);
    return {
      sessionId: sessionManager.getSessionId(),
      title: session.title,
    };
  });
}

export async function seedToolResultTreeSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "Tree tool fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: Record<string, unknown>): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };

    sessionManager.appendMessage({
      role: "user",
      content: "Inspect README",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-readme-call",
          name: "read",
          arguments: {
            path: join(workspacePath, "README.md"),
            offset: 1,
            limit: 20,
          },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "read-readme-call",
      toolName: "read",
      content: [{ type: "text", text: "# tree-command-workspace" }],
      isError: false,
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "README inspected." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendSessionInfo("Tree tool fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Tree tool fixture session",
    };
  });
}

export async function seedForkSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "Fork fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendModelChange(provider: string, modelId: string): string;
        appendSessionInfo(name: string): string;
        appendThinkingLevelChange(thinkingLevel: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    const appendUser = (content: string) =>
      sessionManager.appendMessage({ role: "user", content, timestamp: nextTimestamp() });
    const appendAssistant = (content: string) =>
      sessionManager.appendMessage({ role: "assistant", content, timestamp: nextTimestamp() });

    sessionManager.appendModelChange("openai", "gpt-5.4");
    sessionManager.appendThinkingLevelChange("high");
    appendUser("First fork question");
    appendAssistant("First fork answer");
    appendUser("Second fork question");
    appendAssistant("Second fork answer");
    appendUser("Third fork question");
    appendAssistant("Third fork answer");

    sessionManager.appendSessionInfo("Fork fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Fork fixture session",
    };
  });
}

async function withAgentDirEnv<T>(agentDir: string, action: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await action();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
}

export async function makeWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
  const workspacePath = join(root, name);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), `# ${name}\n`, "utf8");
  return realpath(workspacePath);
}

export async function makeGitWorkspace(name: string): Promise<string> {
  const workspacePath = await makeWorkspace(name);
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  return workspacePath;
}

export async function writeProjectExtension(
  workspacePath: string,
  fileName: string,
  source: string,
): Promise<string> {
  const extensionsDir = join(workspacePath, ".pi", "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const extensionPath = join(extensionsDir, fileName);
  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

export async function initGitRepo(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "Pi App Tests"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.email", "pi-gui-tests@example.com"], {
    cwd: workspacePath,
  });
}

export async function commitAllInGitRepo(workspacePath: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: workspacePath });
}

export async function writeTinyPng(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));
}

export async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}

export async function getDesktopState(window: Page): Promise<DesktopAppState> {
  const state = await window.evaluate(() => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getState();
  });

  if (!state) {
    throw new Error("Desktop state was unavailable");
  }

  return state;
}

export async function getSelectedTranscript(
  window: Page,
): Promise<SelectedTranscriptRecord | null> {
  return window.evaluate(async () => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getSelectedTranscript();
  });
}

export async function waitForSelectedSessionReady(
  window: Page,
  target: {
    readonly sessionId: string;
    readonly workspaceId?: string;
  },
  timeout = 15_000,
): Promise<void> {
  let expectedComposerDraft = "";
  let expectedTitle = "";

  await expect
    .poll(
      async () => {
        const [state, selectedTranscript] = await Promise.all([
          getDesktopState(window),
          getSelectedTranscript(window),
        ]);
        const workspace = state.workspaces.find(
          (entry) =>
            (!target.workspaceId || entry.id === target.workspaceId) &&
            entry.sessions.some((session) => session.id === target.sessionId),
        );
        const session = workspace?.sessions.find((entry) => entry.id === target.sessionId);
        if (
          !workspace ||
          !session ||
          !state.runtimeByWorkspace[workspace.id] ||
          state.selectedWorkspaceId !== workspace.id ||
          state.selectedSessionId !== session.id ||
          selectedTranscript?.workspaceId !== workspace.id ||
          selectedTranscript.sessionId !== session.id
        ) {
          return false;
        }
        expectedComposerDraft = state.composerDraft;
        expectedTitle = session.title;
        return true;
      },
      {
        intervals: [50, 100, 250, 500],
        message: `wait for selected session ${target.sessionId} to finish hydrating`,
        timeout,
      },
    )
    .toBe(true);

  await expect(window.locator(".chat-header__title")).toHaveText(expectedTitle, { timeout });
  await expect(window.getByTestId("transcript-skeleton")).toHaveCount(0, { timeout });
  await expect(window.getByTestId("composer")).toHaveValue(expectedComposerDraft, { timeout });

  let previousLayout = "";
  await expect
    .poll(
      async () => {
        const layout = await window.evaluate(() => {
          const composer = document.querySelector<HTMLElement>('[data-testid="composer-surface"]');
          const timeline = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]');
          if (!composer || !timeline) {
            return "";
          }
          return [
            composer.getBoundingClientRect().height,
            timeline.getBoundingClientRect().height,
            timeline.clientHeight,
            timeline.scrollHeight,
          ].join(":");
        });
        const stable = Boolean(layout) && layout === previousLayout;
        previousLayout = layout;
        return stable;
      },
      {
        intervals: [50, 100, 250],
        message: `wait for selected session ${target.sessionId} layout to settle`,
        timeout,
      },
    )
    .toBe(true);
}

export interface TimelineScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly remainingFromBottom: number;
}

export async function getTimelineScrollMetrics(window: Page): Promise<TimelineScrollMetrics> {
  return window.evaluate(() => {
    const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
    if (!pane) {
      throw new Error("Timeline pane was unavailable");
    }

    return {
      scrollTop: pane.scrollTop,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      remainingFromBottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
    };
  });
}

export async function jumpTimelineToBottom(window: Page): Promise<void> {
  await window.evaluate(() => {
    const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
    if (!pane) {
      throw new Error("Timeline pane was unavailable");
    }
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function scrollTimelineAwayFromBottom(window: Page, pixels = 160): Promise<void> {
  const minimumRemainingFromBottom = Math.min(500, Math.max(1, pixels * 0.5));
  await expect
    .poll(async () =>
      window.evaluate(
        async ({ distance, minimumRemaining }) => {
          const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
          if (!pane) {
            throw new Error("Timeline pane was unavailable");
          }

          const maxScrollTop = pane.scrollHeight - pane.clientHeight;
          if (maxScrollTop <= minimumRemaining) {
            return maxScrollTop;
          }

          pane.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -distance }),
          );
          pane.scrollTop = Math.max(0, maxScrollTop - distance);
          pane.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise<void>((resolve) => {
            globalThis.window.requestAnimationFrame(() => {
              globalThis.window.requestAnimationFrame(() => resolve());
            });
          });
          return pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        },
        { distance: pixels, minimumRemaining: minimumRemainingFromBottom },
      ),
    )
    .toBeGreaterThan(minimumRemainingFromBottom);
}

export async function runOrchestrationRuntimeTool(
  harness: DesktopHarness,
  input: RuntimeToolTestInput,
): Promise<RuntimeToolTestResult> {
  return harness.hooks.runOrchestrationRuntimeTool(input);
}

export async function runScheduledTaskRuntimeTool(
  harness: DesktopHarness,
  input: RuntimeToolTestInput,
): Promise<RuntimeToolTestResult> {
  return harness.hooks.runScheduledTaskRuntimeTool(input);
}

export async function fireDueScheduledTasks(
  harness: DesktopHarness,
  nowIso?: string,
): Promise<DesktopAppState> {
  return harness.hooks.fireDueScheduledTasks(nowIso);
}

export async function emitTestSessionEvent(
  harness: DesktopHarness,
  event: SessionDriverEvent,
): Promise<void> {
  await harness.hooks.emitSessionEvents([event]);
}

export async function emitTestSessionEvents(
  harness: DesktopHarness,
  events: readonly SessionDriverEvent[],
): Promise<void> {
  await harness.hooks.emitSessionEvents(events);
}

/**
 * Deterministically drive the main-process window-activation path (the same one
 * the real `focus` event fires), so a test can assert the focus reconcile without
 * depending on flaky native focus stealing.
 */
export async function triggerWindowActivation(harness: DesktopHarness): Promise<void> {
  await harness.hooks.handleWindowActivation();
}

export async function setDeferredThreadTitleMode(harness: DesktopHarness): Promise<void> {
  await harness.hooks.deferThreadTitles();
}

export async function resolveDeferredThreadTitle(
  harness: DesktopHarness,
  title: string,
): Promise<void> {
  await harness.hooks.resolveDeferredThreadTitle(title);
}

export async function waitForDeferredThreadTitleRequest(
  harness: DesktopHarness,
  timeout = 15_000,
): Promise<void> {
  await expect.poll(() => harness.hooks.hasDeferredThreadTitle(), { timeout }).toBe(true);
}

export async function resolveDeferredThreadTitleEventually(
  harness: DesktopHarness,
  title: string,
  timeout = 15_000,
): Promise<void> {
  let resolved = false;
  await expect
    .poll(
      async () => {
        if (resolved) {
          return "resolved";
        }
        try {
          await harness.hooks.resolveDeferredThreadTitle(title);
          resolved = true;
          return "resolved";
        } catch (error) {
          if (String(error).includes("Deferred thread-title request is unavailable")) {
            return "pending";
          }
          throw error;
        }
      },
      { timeout },
    )
    .toBe("resolved");
}

export async function seedTranscriptMessages(
  harness: DesktopHarness,
  window: Page,
  options: {
    readonly count: number;
    readonly textFactory?: (index: number) => string;
  },
): Promise<{ readonly sessionRef: SessionRef; readonly messages: readonly string[] }> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
  assertExists(selectedWorkspace, "Expected selected workspace while seeding transcript");
  assertExists(selectedSession, "Expected selected session while seeding transcript");

  const sessionRef = {
    workspaceId: selectedWorkspace.id,
    sessionId: selectedSession.id,
  } satisfies SessionRef;
  const workspace = {
    workspaceId: selectedWorkspace.id,
    path: selectedWorkspace.path,
    displayName: selectedWorkspace.name,
  };
  const messages = Array.from({ length: options.count }, (_, index) =>
    options.textFactory ? options.textFactory(index) : `seeded transcript row ${index}`,
  );

  for (const [index, text] of messages.entries()) {
    const startedAt = new Date(Date.now() + index * 2_000).toISOString();
    const completedAt = new Date(Date.now() + index * 2_000 + 1_000).toISOString();
    const runId = `test-run-${index}`;

    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef,
      timestamp: startedAt,
      runId,
      snapshot: {
        ref: sessionRef,
        workspace,
        title: selectedSession.title,
        status: "running",
        updatedAt: startedAt,
        preview: text,
        runningRunId: runId,
      },
    });
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp: startedAt,
      runId,
      text,
    });
    await emitSuccessfulRunCompletion(harness, {
      sessionRef,
      workspace,
      title: selectedSession.title,
      runId,
      completedAt,
      preview: text,
    });
  }

  return { sessionRef, messages };
}

export async function streamAssistantDeltas(
  harness: DesktopHarness,
  window: Page,
  chunks: readonly string[],
  runId = `stream-run-${Date.now()}`,
): Promise<{ readonly sessionRef: SessionRef; readonly fullText: string }> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
  assertExists(selectedWorkspace, "Expected selected workspace while streaming transcript");
  assertExists(selectedSession, "Expected selected session while streaming transcript");

  const sessionRef = {
    workspaceId: selectedWorkspace.id,
    sessionId: selectedSession.id,
  } satisfies SessionRef;
  const workspace = {
    workspaceId: selectedWorkspace.id,
    path: selectedWorkspace.path,
    displayName: selectedWorkspace.name,
  };
  const startedAt = new Date().toISOString();
  const completedAt = new Date(Date.now() + chunks.length * 1_000 + 1_000).toISOString();
  const fullText = chunks.join("");

  await emitTestSessionEvent(harness, {
    type: "sessionUpdated",
    sessionRef,
    timestamp: startedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title: selectedSession.title,
      status: "running",
      updatedAt: startedAt,
      preview: fullText,
      runningRunId: runId,
    },
  });

  for (const [index, chunk] of chunks.entries()) {
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp: new Date(Date.now() + index * 1_000).toISOString(),
      runId,
      text: chunk,
    });
  }

  await emitSuccessfulRunCompletion(harness, {
    sessionRef,
    workspace,
    title: selectedSession.title,
    runId,
    completedAt,
    preview: fullText,
  });

  return { sessionRef, fullText };
}

async function emitSuccessfulRunCompletion(
  harness: DesktopHarness,
  options: {
    readonly sessionRef: SessionRef;
    readonly workspace: {
      readonly workspaceId: string;
      readonly path: string;
      readonly displayName: string;
    };
    readonly title: string;
    readonly runId: string;
    readonly completedAt: string;
    readonly preview: string;
  },
): Promise<void> {
  const { completedAt, preview, runId, sessionRef, title, workspace } = options;

  await emitTestSessionEvent(harness, {
    type: "runCompleted",
    sessionRef,
    timestamp: completedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title,
      status: "idle",
      updatedAt: completedAt,
      preview,
    },
  });
}

export function persistedSessionDataPaths(
  userDataDir: string,
  sessionRef: SessionRef,
): {
  transcriptPath: string;
  attachmentPath: string;
  encodedSessionKey: string;
  rawSessionKey: string;
} {
  const rawSessionKey = `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
  const encodedSessionKey = encodeURIComponent(rawSessionKey);
  return {
    transcriptPath: join(userDataDir, "transcripts", `${encodedSessionKey}.json`),
    attachmentPath: join(userDataDir, "attachments", `${encodedSessionKey}.json`),
    encodedSessionKey,
    rawSessionKey,
  };
}

export function assertExists<T>(value: T | undefined | null, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

export async function waitForWorkspaceByPath(
  window: Page,
  workspacePath: string,
  timeout = 15_000,
): Promise<WorkspaceRecord> {
  await expect
    .poll(
      async () => {
        const state = await getDesktopState(window);
        return state.workspaces.find((workspace) => workspace.path === workspacePath) ?? null;
      },
      { timeout },
    )
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
  assertExists(workspace, `Expected workspace for path ${workspacePath}`);
  return workspace;
}

export async function addWorkspaceViaIpc(window: Page, workspacePath: string): Promise<void> {
  await window.evaluate(async (pathValue) => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    await app.addWorkspacePath(pathValue);
  }, workspacePath);
}

export async function waitForSessionByTitle(
  window: Page,
  workspaceId: string,
  title: string,
  timeout = 15_000,
): Promise<SessionRecord> {
  await expect
    .poll(
      async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
        return workspace?.sessions.find((session) => session.title === title) ?? null;
      },
      { timeout },
    )
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  const session = workspace?.sessions.find((entry) => entry.title === title);
  assertExists(session, `Expected session ${title}`);
  return session;
}

export async function selectSession(window: Page, sessionTitle: string): Promise<void> {
  await clickSession(window, sessionTitle);
  await expect(window.locator(".chat-header__title")).toHaveText(sessionTitle);
}

/**
 * Waits until transcript rows stop moving. Rows are placed from estimates and move once
 * measured; a click whose press and release straddle that move is lost without an error.
 * A resize (such as opening the side panel) reaches the timeline only after the next
 * layout, so let one full frame run before reading the state.
 */
export async function waitForTimelineLayout(window: Page): Promise<void> {
  await window.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(window.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled");
}

export async function selectSidePanel(
  window: Page,
  choice: "Files" | "Review" | "Terminal",
): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) {
    await window.getByTestId("toggle-side-panel").click();
  }
  const existing = workbench.getByRole("tab", { name: choice, exact: true });
  if (await existing.count()) {
    await existing.click();
  } else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) {
      await window.getByTestId("workbench-add-tab").click();
    }
    await chooser.getByRole("button", { name: choice, exact: true }).click();
  }
  await expect(existing).toHaveAttribute("aria-selected", "true");
}

export type ReviewScopeLabel =
  "Last Turn" | "Selected Turn" | "Uncommitted" | "Unstaged" | "Staged" | "Branch";

/** Chooses a comparison from the Review panel's scope menu. */
export async function chooseReviewScope(window: Page, scope: ReviewScopeLabel): Promise<void> {
  await window.getByRole("button", { name: "Review scope", exact: true }).click();
  await window
    .getByRole("menu", { name: "Review scope", exact: true })
    .getByRole("menuitemradio", { name: scope, exact: true })
    .click();
  await expect(reviewScopeButton(window)).toHaveText(scope);
}

/** Opens the Review "…" menu, which lists checkouts and the resolved comparison. */
export async function openReviewOptions(window: Page) {
  await window.getByRole("button", { name: "Review options", exact: true }).click();
  return window.getByRole("menu", { name: "Review options", exact: true });
}

export async function chooseReviewCheckout(window: Page, checkoutId: string): Promise<void> {
  const menu = await openReviewOptions(window);
  await menu.locator(`[role="menuitemradio"][data-option-id="${checkoutId}"]`).click();
}

/** The resolved comparison shown at the top of the Review "…" menu; press Escape to close. */
export async function reviewComparisonIdentity(window: Page) {
  return (await openReviewOptions(window)).getByTestId("review-comparison-identity");
}

export function reviewScopeButton(window: Page) {
  return window.getByRole("button", { name: "Review scope", exact: true });
}

export async function clickSession(window: Page, sessionTitle: string): Promise<void> {
  await window.locator(".session-row__select", { hasText: sessionTitle }).click();
}

export async function openNewThread(window: Page): Promise<void> {
  const composer = window.getByTestId("new-thread-composer");
  if (await composer.isVisible().catch(() => false)) {
    return;
  }
  const button = window
    .locator(".sidebar")
    .getByRole("button", { name: "New thread", exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  await expect(composer).toBeVisible({ timeout: 15_000 });
}

export async function expectNewThreadWorkspace(window: Page, workspacePath: string): Promise<void> {
  const workspace = await waitForWorkspaceByPath(window, workspacePath);
  await expect(window.getByTestId("new-thread-composer")).toBeVisible({ timeout: 15_000 });
  await expect(window.locator(".new-thread__workspace")).toHaveValue(workspace.id);
}

export async function startThreadFromSurface(
  window: Page,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly prompt?: string;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const { environment = "local", prompt = "Start thread", workspaceName } = options;

  await openNewThread(window);
  if (workspaceName) {
    await window.locator(".new-thread__workspace").selectOption({ label: workspaceName });
  }
  if (environment === "worktree") {
    await window.getByRole("button", { name: "Worktree", exact: true }).click();
  } else {
    await window.getByRole("button", { name: "Local", exact: true }).click();
  }
  const startButton = window.getByRole("button", { name: "Start thread" });
  if (prompt) {
    await window.getByLabel("New thread prompt").fill(prompt);
  }
  await expect(startButton).toBeEnabled({ timeout: 15_000 });
  await startButton.click();
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId("composer")).toBeFocused({ timeout: 15_000 });
}

export async function startThreadViaIpc(
  window: Page,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly prompt?: string;
    readonly provider?: string;
    readonly modelId?: string;
    readonly thinkingLevel?: string;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const {
    environment = "local",
    prompt = "Start thread",
    provider,
    modelId,
    thinkingLevel,
    workspaceName,
  } = options;

  const rootWorkspaceId = await window.evaluate(
    async ({ requestedWorkspaceName }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const state = await app.getState();
      const targetWorkspace = requestedWorkspaceName
        ? state.workspaces.find((workspace) => workspace.name === requestedWorkspaceName)
        : state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
      if (!targetWorkspace) {
        throw new Error(
          requestedWorkspaceName
            ? `Workspace not found: ${requestedWorkspaceName}`
            : "No selected workspace while starting thread",
        );
      }
      return targetWorkspace.rootWorkspaceId ?? targetWorkspace.id;
    },
    { requestedWorkspaceName: workspaceName },
  );

  await window.evaluate(
    async ({
      rootWorkspaceId,
      nextEnvironment,
      nextPrompt,
      nextProvider,
      nextModelId,
      nextThinkingLevel,
    }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.startThread({
        rootWorkspaceId,
        environment: nextEnvironment,
        prompt: nextPrompt,
        provider: nextProvider,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
    },
    {
      rootWorkspaceId,
      nextEnvironment: environment,
      nextPrompt: prompt,
      nextProvider: provider,
      nextModelId: modelId,
      nextThinkingLevel: thinkingLevel,
    },
  );
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

export async function createNamedThread(
  window: Page,
  title: string,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const { environment = "local", workspaceName } = options;
  if (environment !== "local") {
    await startThreadFromSurface(window, {
      environment,
      prompt: title,
      workspaceName,
    });
    return;
  }

  const targetWorkspaceId = await window.evaluate(
    ({ requestedWorkspaceName }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.getState().then((state) => {
        if (requestedWorkspaceName) {
          const namedWorkspace = state.workspaces.find(
            (workspace) => workspace.name === requestedWorkspaceName,
          );
          if (!namedWorkspace) {
            throw new Error(`Workspace not found: ${requestedWorkspaceName}`);
          }
          return namedWorkspace.id;
        }

        if (!state.selectedWorkspaceId) {
          throw new Error("No selected workspace");
        }

        return state.selectedWorkspaceId;
      });
    },
    { requestedWorkspaceName: workspaceName },
  );

  await createSessionViaIpc(window, targetWorkspaceId, title);
  await selectSession(window, title);
  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await expect(composer).toBeFocused({ timeout: 15_000 });
}

export async function chooseThreadGrouping(
  window: Page,
  grouping: "time" | "workspace",
): Promise<void> {
  const label = grouping === "time" ? "Time" : "Workspace";
  await window.getByRole("button", { name: "Customize Sidebar" }).click();
  await window.getByRole("menuitem", { name: "Grouping" }).click();
  await window.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expectThreadGrouping(window, grouping);
}

export async function expectThreadGrouping(
  window: Page,
  grouping: "time" | "workspace",
): Promise<void> {
  const label = grouping === "time" ? "Time" : "Workspace";
  await window.getByRole("button", { name: "Customize Sidebar" }).click();
  await window.getByRole("menuitem", { name: "Grouping" }).click();
  await expect(window.getByRole("menuitemradio", { name: label, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expectCompactGroupingMenu(window);
  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu", { name: "Customize Sidebar" })).toBeHidden();
}

async function expectCompactGroupingMenu(window: Page): Promise<void> {
  const viewportWidth = await window.evaluate(() => document.documentElement.clientWidth);
  const submenu = window.getByRole("menu", { name: "Grouping" });
  const submenuBox = await submenu.boundingBox();
  const timeBox = await window
    .getByRole("menuitemradio", { name: "Time", exact: true })
    .boundingBox();
  expect(submenuBox, "Grouping submenu should be visible").not.toBeNull();
  expect(timeBox, "Time option should be visible").not.toBeNull();
  expect(
    submenuBox!.width,
    `Grouping submenu is ${submenuBox!.width}px in a ${viewportWidth}px window`,
  ).toBeLessThan(viewportWidth / 2);
  expect(submenuBox!.width).toBeLessThan(240);
  expect(timeBox!.width).toBeGreaterThan(submenuBox!.width * 0.7);
}

export async function createSessionViaIpc(
  window: Page,
  workspaceIdOrPath: string,
  title: string,
): Promise<void> {
  await window.evaluate(
    async ({ workspaceTarget, targetTitle }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = await app.getState();
        const workspace = state.workspaces.find(
          (entry) => entry.id === workspaceTarget || entry.path === workspaceTarget,
        );
        if (workspace) {
          await app.createSession({ workspaceId: workspace.id, title: targetTitle });
          return;
        }
        await new Promise((resolve) => globalThis.window.setTimeout(resolve, 100));
      }

      throw new Error(`Workspace not found: ${workspaceTarget}`);
    },
    { workspaceTarget: workspaceIdOrPath, targetTitle: title },
  );

  await expect(window.locator(".session-row__select", { hasText: title })).toBeVisible({
    timeout: 15_000,
  });
}

export async function reloadDesktopRenderer(window: Page): Promise<void> {
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
    timeout: 15_000,
  });
}
