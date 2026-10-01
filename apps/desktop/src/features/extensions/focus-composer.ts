/**
 * Runs `hide` for a control that disappears with what it hides, then moves focus to the
 * composer so keyboard and screen reader users are not dropped onto the page body.
 */
export function focusComposerAfter(control: HTMLElement, hide: () => void): void {
  const composer = control.closest(".composer__surface")?.querySelector("textarea");
  hide();
  requestAnimationFrame(() => composer?.focus());
}
