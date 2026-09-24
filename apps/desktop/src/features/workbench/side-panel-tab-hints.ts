import { getSidePanelTabCommand, sidePanelTabModifierHeld } from "../../../contracts/ipc";
import { createModifierHints } from "../../ui/modifier-hints";

const heldInput = (event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">) => ({
  meta: event.metaKey,
  control: event.ctrlKey,
  alt: event.altKey,
  shift: false,
});

/**
 * Tab number hints on side panel tabs, from a press of Control on macOS or Alt
 * elsewhere until it is released. Tab chords work from the terminal too.
 */
const sidePanelTabHints = createModifierHints({
  modifierKey: (platform) => (platform === "darwin" ? "Control" : "Alt"),
  held: (event, platform) => sidePanelTabModifierHeld(platform, heldInput(event)),
  keepsHints: (event, platform) =>
    getSidePanelTabCommand(platform, {
      ...heldInput(event),
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    }) !== undefined,
});

export const nextSidePanelTabHintsVisible = sidePanelTabHints.next;
export const dismissSidePanelTabHints = sidePanelTabHints.dismiss;
export const useSidePanelTabHintsVisible = sidePanelTabHints.useVisible;
