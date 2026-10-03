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
  readonly detect: () => readonly DetectedEditor[];
  readonly detectDefault: (editors: readonly DetectedEditor[]) => string | undefined;
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
 * cache. A launch failure clears the cache so the next menu reflects what is
 * still on disk, which covers an editor uninstalled while the app kept running.
 */
export class EditorService {
  private detected: readonly DetectedEditor[] | undefined;
  private preferredEditorId: string | undefined;
  private osDefaultEditorId: string | null | undefined;
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

  list(): DesktopEditorList {
    const editors = this.detectedEditors();
    const preferredEditorId = this.resolvePreferredEditorId(editors);
    return {
      editors: editors.map(({ id, label, shortLabel }) => ({ id, label, shortLabel })),
      ...(preferredEditorId ? { preferredEditorId } : {}),
    };
  }

  async open(workspacePath: string, editorId: string): Promise<DesktopEditorList> {
    const editor = this.findEditor(editorId) ?? this.redetect(editorId);
    if (!editor) {
      throw new Error(`Unknown editor: ${editorId}`);
    }
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
  select(editorId: string): DesktopEditorList {
    const editor = this.findEditor(editorId) ?? this.redetect(editorId);
    if (!editor) {
      throw new Error(`Unknown editor: ${editorId}`);
    }
    this.preferredEditorId = editor.id;
    return this.list();
  }

  private detectedEditors(): readonly DetectedEditor[] {
    this.detected ??= this.deps.detect();
    return this.detected;
  }

  /** The user's last pick wins; otherwise the OS default handler. */
  private resolvePreferredEditorId(editors: readonly DetectedEditor[]): string | undefined {
    if (this.preferredEditorId && editors.some((editor) => editor.id === this.preferredEditorId)) {
      return this.preferredEditorId;
    }
    const osDefault = this.defaultEditorId(editors);
    return osDefault && editors.some((editor) => editor.id === osDefault) ? osDefault : undefined;
  }

  private defaultEditorId(editors: readonly DetectedEditor[]): string | undefined {
    // Probed once: the OS handler rarely changes and the probe spawns commands.
    if (this.osDefaultEditorId === undefined) {
      this.osDefaultEditorId = this.deps.detectDefault(editors) ?? null;
    }
    return this.osDefaultEditorId ?? undefined;
  }

  private findEditor(editorId: string): DetectedEditor | undefined {
    return this.detectedEditors().find((editor) => editor.id === editorId);
  }

  private redetect(editorId: string): DetectedEditor | undefined {
    this.detected = undefined;
    return this.findEditor(editorId);
  }
}
