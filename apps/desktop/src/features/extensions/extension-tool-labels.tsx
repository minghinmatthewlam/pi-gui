import { createContext, useContext, useMemo } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { extensionToolLabels, type ExtensionToolLabels } from "../../../contracts/tool-labels";

/** Tool labels for the selected folder's extensions, read by transcript tool rows. */
export const ExtensionToolLabelsContext = createContext<ExtensionToolLabels>(new Map());

/**
 * The selected folder's extension tool labels, as a map that keeps its identity while the labels
 * are unchanged: runtime snapshots arrive as new objects on every state update, and a new map
 * would re-render every tool row in the transcript.
 */
export function useExtensionToolLabels(runtime: RuntimeSnapshot | undefined): ExtensionToolLabels {
  const signature = JSON.stringify([...extensionToolLabels(runtime)]);
  return useMemo(() => new Map(JSON.parse(signature) as [string, string][]), [signature]);
}

export function useExtensionToolLabel(toolName: string): string | undefined {
  return useContext(ExtensionToolLabelsContext).get(toolName);
}
