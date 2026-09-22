import type { SessionRef } from "@pi-gui/session-driver/types";

export interface DesktopExtensionViewInfo {
  readonly id: string;
  readonly extensionId: string;
  readonly title: string;
  readonly generation: string;
  readonly state: "ready" | "error";
  readonly error?: string;
}

export interface OpenExtensionViewInput {
  readonly target: SessionRef;
  readonly extensionId: string;
  readonly viewId: string;
}

export interface ExtensionViewConnection {
  readonly connectionId: string;
  readonly frameUrl: string;
}

export interface ExtensionViewMessage {
  readonly connectionId: string;
  readonly message: unknown;
}

export interface ExtensionViewCatalogChange {
  readonly target: SessionRef;
  readonly views: readonly DesktopExtensionViewInfo[];
}

export interface ExtensionViewOpenFile {
  readonly target: SessionRef;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}
