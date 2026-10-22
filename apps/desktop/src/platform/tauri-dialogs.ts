/**
 * The text prompt provider sign-in asks for (a code, a name). Electron main opens a modal
 * window of its own; the Tauri shell asks the window's page instead, which shows this dialog
 * over the app with the same message, field and buttons, and answers through
 * `pi_prompt_answer`.
 */

export interface TextPromptRequest {
  readonly id: number;
  readonly message: string;
  readonly placeholder: string;
}

/** The text, or `null` for Cancel, Escape or the dialog going away. */
export type TextPromptAnswer = (id: number, value: string | null) => void;

export const TEXT_PROMPT_CHANNEL = "pi-gui:text-prompt";

const DIALOG_STYLE = `
  .pi-text-prompt { width: 460px; max-width: calc(100vw - 32px); padding: 18px 20px; border: 1px solid var(--line, #c3c8d0);
    border-radius: 10px; background: var(--elevated, #f4f5f7); color: var(--text-strong, #1b1d22);
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 18px 48px rgb(0 0 0 / 0.28); }
  .pi-text-prompt::backdrop { background: rgb(0 0 0 / 0.32); }
  .pi-text-prompt form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
  .pi-text-prompt .msg { line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pi-text-prompt input { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; border-radius: 6px;
    border: 1px solid var(--line-strong, #c3c8d0); background: var(--main, #fff); color: inherit; }
  .pi-text-prompt input:focus { outline: 2px solid var(--accent, #4a8cff); outline-offset: 0; border-color: var(--accent, #4a8cff); }
  .pi-text-prompt .row { display: flex; justify-content: flex-end; gap: 8px; }
  .pi-text-prompt button { padding: 6px 16px; font: inherit; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
  .pi-text-prompt #pi-prompt-cancel { background: transparent; border-color: var(--line-strong, #b7bdc7); color: inherit; }
  .pi-text-prompt #pi-prompt-ok { background: var(--accent, #2f6ae0); color: #fff; }
`;

let styleInstalled = false;

function installStyle(): void {
  if (styleInstalled) return;
  styleInstalled = true;
  const style = document.createElement("style");
  style.textContent = DIALOG_STYLE;
  document.head.append(style);
}

/** Shows one prompt; a newer prompt opens over an older one, as Electron's windows stack. */
export function showTextPrompt(request: TextPromptRequest, answer: TextPromptAnswer): void {
  installStyle();
  const dialog = document.createElement("dialog");
  dialog.className = "pi-text-prompt";
  dialog.dataset.promptId = String(request.id);
  const form = document.createElement("form");
  const message = document.createElement("div");
  message.className = "msg";
  message.textContent = request.message;
  const input = document.createElement("input");
  input.id = "pi-prompt-input";
  input.type = "text";
  input.placeholder = request.placeholder;
  input.autocomplete = "off";
  const row = document.createElement("div");
  row.className = "row";
  const cancel = document.createElement("button");
  cancel.id = "pi-prompt-cancel";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.id = "pi-prompt-ok";
  ok.type = "submit";
  ok.textContent = "OK";
  row.append(cancel, ok);
  form.append(message, input, row);
  dialog.append(form);

  let settled = false;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    dialog.close();
    dialog.remove();
    answer(request.id, value);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    finish(input.value);
  });
  cancel.addEventListener("click", () => finish(null));
  // Escape fires `cancel` on a modal dialog.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(null);
  });
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
