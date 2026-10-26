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

/**
 * Detects installed editors once, then answers list/open requests from that
 * cache. Detection is asynchronous and shared: concurrent requests from several
 * windows await one in-flight probe instead of starting their own. A launch
 * failure clears the cache so the next menu reflects what is still on disk,
 * which covers an editor uninstalled while the app kept running.
 */
export class EditorService {
  private detected: Promise<readonly DetectedEditor[]> | undefined;
  private osDefaultEditorId: Promise<string | undefined> | undefined;
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
    const editors = await this.detectedEditors();
    const preferredEditorId = await this.resolvePreferredEditorId(editors);
    return {
      editors: editors.map(({ id, label, shortLabel }) => ({ id, label, shortLabel })),
      ...(preferredEditorId ? { preferredEditorId } : {}),
    };
  }

  async open(workspacePath: string, editorId: string): Promise<DesktopEditorList> {
    const editor = await this.requireEditor(editorId);
    const { command, args } = buildEditorLaunchCommand(editor, workspacePath);
    try {
      await this.deps.launch(command, args);
    } catch (error) {
      this.detected = undefined;
      throw error;
    }
    this.preferredEditorId = editor.id;
    return this.list();
  }

  /** Records the user's pick without launching anything. */
  async select(editorId: string): Promise<DesktopEditorList> {
    const editor = await this.requireEditor(editorId);
    this.preferredEditorId = editor.id;
    return this.list();
  }

  private detectedEditors(): Promise<readonly DetectedEditor[]> {
    if (!this.detected) {
      const probe = this.deps.detect().catch((error: unknown) => {
        // A failed probe must not pin an empty answer; the next request retries.
        if (this.detected === probe) {
          this.detected = undefined;
        }
        throw error;
      });
      this.detected = probe;
    }
    return this.detected;
  }

  /** The user's last pick wins; otherwise the OS default handler. */
  private async resolvePreferredEditorId(
    editors: readonly DetectedEditor[],
  ): Promise<string | undefined> {
    if (this.preferredEditorId && editors.some((editor) => editor.id === this.preferredEditorId)) {
      return this.preferredEditorId;
    }
    // Probed once: the OS handler rarely changes and the probe spawns commands.
    this.osDefaultEditorId ??= this.deps.detectDefault(editors).catch(() => undefined);
    const osDefault = await this.osDefaultEditorId;
    return osDefault && editors.some((editor) => editor.id === osDefault) ? osDefault : undefined;
  }

  /** A known editor, re-probing once in case it was installed after the first probe. */
  private async requireEditor(editorId: string): Promise<DetectedEditor> {
    const find = async () =>
      (await this.detectedEditors()).find((editor) => editor.id === editorId);
    let editor = await find();
    if (!editor) {
      this.detected = undefined;
      editor = await find();
    }
    if (!editor) {
      throw new Error(`Unknown editor: ${editorId}`);
    }
    return editor;
  }
}
