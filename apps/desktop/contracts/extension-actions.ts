import type { ExtensionAction, SessionRef } from "@pi-gui/session-driver";

/** A card button's click: the card's thread and the action it names. */
export interface ExtensionActionRequest {
  readonly target: SessionRef;
  readonly action: ExtensionAction;
}

/**
 * What the renderer does after main ran a button's operation: open a checked file in the
 * side panel, or add text to the composer draft. Operations with nothing to show return none.
 */
export type ExtensionActionEffect =
  | { readonly kind: "openFile"; readonly path: string; readonly line?: number }
  | { readonly kind: "composer"; readonly text: string };
