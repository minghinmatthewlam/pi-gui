import { spawn } from "node:child_process";
import type { DesktopEditorList } from "../../../contracts/editors";
import {
  buildEditorLaunchCommand,
  createEditorDetectionHost,
  detectDefaultEditorId,
  detectInstalledEditors,
  type DetectedEditor,
} from "./detect-editors";

export interface EditorServiceDeps {
  readonly detect: () => Promise<readonly DetectedEditor[]>;
  readonly detectDefault: (editors: readonly DetectedEditor[]) => Promise<string | undefined>;
  readonly launch: (command: string, args: readonly string[]) => Promise<void>;
}

function launchWithSpawn(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // A foreground editor owns its own process for as long as it is open, so the
    // launch must resolve when the process starts, not when it exits.
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

/** One probe's answer: the installed editors and which of them the OS opens folders with. */
interface EditorDetection {
  readonly editors: readonly DetectedEditor[];
  readonly osDefaultEditorId: string | undefined;
}

/**
 * Detects installed editors and the OS default once, then answers list/open
 * requests from that snapshot. Detection is asynchronous and shared: concurrent
 * requests from several windows await one in-flight probe instead of starting
 * their own. An unknown id or a launch failure drops the snapshot, so the next
 * request re-probes what is on disk, which covers an editor installed or
 * uninstalled while the app kept running.
 */
export class EditorService {
  private detection: Promise<EditorDetection> | undefined;
  /** The user's pick for this app session; not persisted across restarts. */
  private preferredEditorId: string | undefined;
  private readonly deps: EditorServiceDeps;

  constructor(deps?: EditorServiceDeps) {
    if (deps) {
      this.deps = deps;
      return;
    }
    const host = createEditorDetectionHost();
    this.deps = {
      detect: () => detectInstalledEditors(host),
      detectDefault: (editors) => detectDefaultEditorId(host, editors),
      launch: launchWithSpawn,
    };
  }

  async list(): Promise<DesktopEditorList> {
    return this.describe(await this.detect());
  }

  async open(workspacePath: string, editorId: string): Promise<DesktopEditorList> {
    const { editor, detection } = await this.requireEditor(editorId);
    const { command, args } = buildEditorLaunchCommand(editor, workspacePath);
    try {
      await this.deps.launch(command, args);
    } catch (error) {
      this.invalidate(detection);
      throw error;
    }
    this.preferredEditorId = editor.id;
    return this.list();
  }

  /** Records the user's pick without launching anything. */
  async select(editorId: string): Promise<DesktopEditorList> {
    const { editor } = await this.requireEditor(editorId);
    this.preferredEditorId = editor.id;
    return this.list();
  }

  private detect(): Promise<EditorDetection> {
    if (!this.detection) {
      const probe = this.probe();
      this.detection = probe;
      // A failed probe must not pin its rejection; the next request retries.
      probe.catch(() => this.invalidate(probe));
    }
    return this.detection;
  }

  private async probe(): Promise<EditorDetection> {
    const editors = await this.deps.detect();
    // A failed OS-default probe only means the main button falls back to the
    // first editor; it must not hide the editors that were found.
    const osDefaultEditorId = await this.deps.detectDefault(editors).catch(() => undefined);
    return { editors, osDefaultEditorId };
  }

  /** Drops `stale` only if no newer probe has replaced it. */
  private invalidate(stale: Promise<EditorDetection>): void {
    if (this.detection === stale) {
      this.detection = undefined;
    }
  }

  /** The user's last pick wins; otherwise the OS default handler. */
  private describe({ editors, osDefaultEditorId }: EditorDetection): DesktopEditorList {
    const installed = (id: string | undefined) => editors.some((editor) => editor.id === id);
    const preferredEditorId = installed(this.preferredEditorId)
      ? this.preferredEditorId
      : installed(osDefaultEditorId)
        ? osDefaultEditorId
        : undefined;
    return {
      editors: editors.map(({ id, label, shortLabel }) => ({ id, label, shortLabel })),
      ...(preferredEditorId ? { preferredEditorId } : {}),
    };
  }

  /** A known editor, re-probing once in case it was installed after the last probe. */
  private async requireEditor(
    editorId: string,
  ): Promise<{ editor: DetectedEditor; detection: Promise<EditorDetection> }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const detection = this.detect();
      const editor = (await detection).editors.find((entry) => entry.id === editorId);
      if (editor) {
        return { editor, detection };
      }
      this.invalidate(detection);
    }
    throw new Error(`Unknown editor: ${editorId}`);
  }
}
