import type { KeyboardEvent } from "react";

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && !element.getAttribute("aria-hidden"));
}

export function trapDialogFocus(
  event: KeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
): void {
  if (!dialog) {
    return;
  }

  const focusable = getFocusableElements(dialog);

  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function restoreTopmostDialogFocus(): boolean {
  const dialogs = document.querySelectorAll<HTMLElement>("[aria-modal='true']");
  const dialog = dialogs.item(dialogs.length - 1);
  if (!dialog) {
    return false;
  }
  if (!dialog.contains(document.activeElement)) {
    (getFocusableElements(dialog)[0] ?? dialog).focus();
  }
  return true;
}
