import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SUPPORTED_COMPOSER_IMAGE_TYPES } from "../../contracts/composer-attachments";
import {
  desktopIpc,
  getDesktopCommandFromShortcut,
  getSidePanelTabCommand,
  isCloseFocusedSurfaceShortcut,
  isSinglePressCommand,
  platformShortcutModifier,
} from "../../contracts/ipc";
import { recordFilePath } from "./file-paths";
import {
  createPiAppBridge,
  encodeKernelArgs,
  settleKernelAnswer,
  type KernelAnswer,
} from "./pi-app-api";
import { showTextPrompt, TEXT_PROMPT_CHANNEL, type TextPromptRequest } from "./tauri-dialogs";

/**
 * `window.piApp` in the Tauri app, standing in for the Electron preload. Calls go to the
 * in-process kernel through the `pi_invoke` command with the test host's contract, and the
 * window's pushes arrive on one channel. It also does what Electron main did for the page:
 * file drops become DOM drops with known paths, the window's own shortcuts reach the shell, chords
 * pressed inside extension view frames reach the page, and sign-in text prompts show here.
 */

interface Bootstrap {
  readonly window: number;
  readonly platform: NodeJS.Platform;
  readonly versions: Record<string, string>;
}

interface PushMessage {
  readonly channel: string;
  readonly payload: unknown;
}

export function isTauriWebview(): boolean {
  return isTauri();
}

/** Installs `window.piApp` and connects the window's pushes. */
export async function installTauriPiApp(): Promise<void> {
  const boot = await invoke<Bootstrap>("pi_bootstrap");
  const bridge = createPiAppBridge(
    {
      request: async (method, args) =>
        settleKernelAnswer(
          await invoke<KernelAnswer>("pi_invoke", { method, ...encodeKernelArgs(args) }),
        ),
      send: (method, args) => {
        void invoke("pi_invoke", { method, ...encodeKernelArgs(args), send: true }).catch(
          (error: unknown) => {
            console.error(`[piApp] ${method} failed`, error);
          },
        );
      },
    },
    { platform: boot.platform, versions: boot.versions },
  );
  window.piApp = bridge.api;
  const pushes = new Channel<PushMessage>((message) => {
    if (message.channel === TEXT_PROMPT_CHANNEL) {
      showTextPrompt(message.payload as TextPromptRequest, (id, value) => {
        void invoke("pi_prompt_answer", { id, value }).catch((error: unknown) => {
          console.error("[piApp] answering the text prompt failed", error);
        });
      });
      return;
    }
    bridge.deliver(message.channel, message.payload);
  });
  await invoke("pi_connect", { channel: pushes });
  installWindowShortcuts(boot.platform);
  installFrameChords(boot.platform, (command) => bridge.deliver(desktopIpc.appCommand, command));
  await installFileDrops();
}

/**
 * Electron main's own chords: a new window and the folder picker. macOS has them in its
 * menu; elsewhere the page forwards them, since the webview has no input hook in the shell.
 */
function installWindowShortcuts(platform: NodeJS.Platform): void {
  if (platform === "darwin") return;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const command =
        event.shiftKey && (key === "n" || event.code === "KeyN")
          ? "newWindow"
          : !event.shiftKey && (key === "o" || event.code === "KeyO")
            ? "openFolder"
            : undefined;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void invoke("pi_window_command", { command }).catch((error: unknown) => {
        console.error(`[piApp] ${command} failed`, error);
      });
    },
    true,
  );
}

interface FrameChord {
  readonly type: "pi-gui:frame-chord";
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

function isFrameChord(data: unknown): data is FrameChord {
  if (typeof data !== "object" || data === null) return false;
  const chord = data as Record<string, unknown>;
  return (
    chord.type === "pi-gui:frame-chord" &&
    typeof chord.key === "string" &&
    typeof chord.code === "string" &&
    ["repeat", "metaKey", "ctrlKey", "altKey", "shiftKey"].every(
      (name) => typeof chord[name] === "boolean",
    )
  );
}

/** Whether a message came from one of this page's own frames. */
function fromChildFrame(source: MessageEventSource | null): boolean {
  if (!source) return false;
  return Array.from(document.querySelectorAll("iframe")).some(
    (frame) => frame.contentWindow === source,
  );
}

/**
 * Electron main sees every key before any frame, so the app's chords work while an extension
 * view has focus. Here a script in each frame (`FRAME_CHORDS_SCRIPT` in the shell) posts its
 * chords to this page, which treats them as main did: Mod+W asks the shell, which closes the
 * focused side panel tool; tab chords and app shortcuts become app commands.
 */
function installFrameChords(
  platform: NodeJS.Platform,
  dispatch: (command: string) => void,
): void {
  window.addEventListener("message", (event) => {
    if (!isFrameChord(event.data) || !fromChildFrame(event.source)) return;
    const chord = event.data;
    const input = {
      meta: chord.metaKey,
      control: chord.ctrlKey,
      alt: chord.altKey,
      shift: chord.shiftKey,
      key: chord.key,
      code: chord.code,
    };
    if (isCloseFocusedSurfaceShortcut({ ...input, platform })) {
      void invoke("pi_window_command", { command: "closeShortcut" }).catch((error: unknown) => {
        console.error("[piApp] closeShortcut failed", error);
      });
      return;
    }
    const sidePanelTabCommand = getSidePanelTabCommand(platform, input);
    if (sidePanelTabCommand) {
      if (!chord.repeat) dispatch(sidePanelTabCommand);
      return;
    }
    const command = getDesktopCommandFromShortcut({
      modifier: platformShortcutModifier(platform, input),
      alt: chord.altKey,
      shift: chord.shiftKey,
      key: chord.key,
      code: chord.code,
    });
    // Holding a palette chord would open and close it at the repeat rate.
    if (command && !(isSinglePressCommand(command) && chord.repeat)) dispatch(command);
  });
}

const IMAGE_TYPE_BY_EXTENSION = new Map<string, string>(
  SUPPORTED_COMPOSER_IMAGE_TYPES.map(({ extension, mimeType }) => [extension, mimeType]),
);

function fileName(path: string): string {
  return path.split(/[/\\]+/).pop() ?? path;
}

/** A DOM File for a dropped path: bytes for images, which the composer reads, else its size. */
async function droppedFile(path: string): Promise<File> {
  const name = fileName(path);
  const imageType = IMAGE_TYPE_BY_EXTENSION.get(name.split(".").pop()?.toLowerCase() ?? "");
  let file: File;
  if (imageType) {
    const bytes = await invoke<ArrayBuffer>("pi_dropped_file", { path, contents: true });
    file = new File([bytes], name, { type: imageType });
  } else {
    const { size } = await invoke<{ size: number }>("pi_dropped_file", { path, contents: false });
    file = new File([], name);
    // The composer only records a file's path and size; its bytes stay on disk.
    Object.defineProperty(file, "size", { value: size });
  }
  recordFilePath(file, path);
  return file;
}

function transferOf(files: readonly File[]): DataTransfer {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
}

/**
 * The webview takes file drags natively and reports paths and a position instead of DOM drag
 * events. They are replayed as DOM events on the element under the pointer, so the composer's
 * drop handling is the same as under Electron.
 */
async function installFileDrops(): Promise<void> {
  let target: Element | null = null;
  let dragged: File[] = [];
  const elementAt = (position: { x: number; y: number }): Element | null => {
    const scale = window.devicePixelRatio || 1;
    return document.elementFromPoint(position.x / scale, position.y / scale);
  };
  const fire = (element: Element | null, type: string, files: readonly File[]): void => {
    element?.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transferOf(files),
      }),
    );
  };
  await getCurrentWebview().onDragDropEvent((event) => {
    const drag = event.payload;
    if (drag.type === "enter") {
      // Placeholders until the drop: the page only checks that files are coming.
      dragged = drag.paths.map((path) => new File([], fileName(path)));
      target = elementAt(drag.position);
      fire(target, "dragenter", dragged);
      fire(target, "dragover", dragged);
      return;
    }
    if (drag.type === "over") {
      const next = elementAt(drag.position);
      if (next !== target) {
        fire(target, "dragleave", dragged);
        fire(next, "dragenter", dragged);
        target = next;
      }
      fire(target, "dragover", dragged);
      return;
    }
    if (drag.type === "leave") {
      fire(target, "dragleave", dragged);
      target = null;
      return;
    }
    const dropTarget = elementAt(drag.position);
    target = null;
    void Promise.all(drag.paths.map(droppedFile)).then(
      (files) => fire(dropTarget, "drop", files),
      (error: unknown) => {
        console.error("[piApp] reading dropped files failed", error);
      },
    );
  });
}
