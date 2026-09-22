import { randomUUID } from "node:crypto";
import {
  createEventBus,
  type CreateAgentSessionServicesOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  DESKTOP_VIEW_DISCOVER,
  DESKTOP_VIEW_REGISTER,
  DESKTOP_VIEW_UNREGISTER,
  type DesktopViewDeclaration,
  type DesktopViewRegistrationEvent,
} from "@pi-gui/extension-ui";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

type ResourceLoaderOptions = NonNullable<
  CreateAgentSessionServicesOptions["resourceLoaderOptions"]
>;

export interface PiDesktopExtensionRuntime {
  readonly target: SessionRef;
  readonly generation: string;
  readonly extensions: readonly { readonly resolvedPath: string }[];
  readonly declarations: readonly DesktopViewDeclaration[];
}

export interface PiDesktopExtensionObserver {
  /** Invoked immediately; asynchronous UI work must not delay ordinary Pi lifecycle events. */
  onChanged(runtime: PiDesktopExtensionRuntime): void | Promise<void>;
  /** Revoke capabilities before awaiting cleanup; Pi does not wait for authored view code. */
  onInvalidated(runtime: {
    readonly target: SessionRef;
    readonly generation: string;
  }): void | Promise<void>;
}

/** A discovery adapter around stable Pi extension APIs; Chord hosts stay with the caller. */
export function createDesktopExtensionBridge(options: {
  readonly workspace: WorkspaceRef;
  readonly observer: PiDesktopExtensionObserver;
}): {
  mergeResourceLoaderOptions(existing: ResourceLoaderOptions): ResourceLoaderOptions;
} {
  const eventBus = createEventBus();
  const declarations = new Set<DesktopViewDeclaration>();
  let loadedExtensions: readonly { readonly resolvedPath: string }[] = [];
  let active: { readonly target: SessionRef; readonly generation: string } | undefined;
  let discovering = false;

  const notify = (operation: () => void | Promise<void>): void => {
    try {
      void Promise.resolve(operation()).catch((error: unknown) => {
        console.error("Desktop extension lifecycle failed", error);
      });
    } catch (error) {
      console.error("Desktop extension lifecycle failed", error);
    }
  };

  const publish = (): void => {
    const epoch = active;
    if (!epoch || discovering) return;
    const snapshot: PiDesktopExtensionRuntime = {
      ...epoch,
      extensions: loadedExtensions.map((extension) => ({ ...extension })),
      declarations: [...declarations],
    };
    notify(() => options.observer.onChanged(snapshot));
  };

  eventBus.on(DESKTOP_VIEW_REGISTER, (value) => {
    if (!isRegistration(value)) return;
    declarations.add(value.declaration);
    value.accept?.();
    publish();
  });
  eventBus.on(DESKTOP_VIEW_UNREGISTER, (value) => {
    if (!declarations.delete(value as DesktopViewDeclaration)) return;
    publish();
  });

  const lifecycle: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, context) => {
      active = {
        target: {
          workspaceId: options.workspace.workspaceId,
          sessionId: context.sessionManager.getSessionId(),
        },
        generation: randomUUID(),
      };
      // Only live Pi extension instances answer; registration does not execute their factory again.
      declarations.clear();
      discovering = true;
      try {
        eventBus.emit(DESKTOP_VIEW_DISCOVER, {});
      } finally {
        discovering = false;
      }
      publish();
    });
    pi.on("session_shutdown", () => {
      const epoch = active;
      active = undefined;
      declarations.clear();
      if (!epoch) return;
      notify(() => options.observer.onInvalidated(epoch));
    });
  };

  return {
    mergeResourceLoaderOptions(existing) {
      return {
        ...existing,
        eventBus,
        extensionFactories: [
          ...(existing.extensionFactories ?? []),
          { name: "pi-gui-desktop-views", hidden: true, factory: lifecycle },
        ],
        extensionsOverride(result) {
          const selected = existing.extensionsOverride?.(result) ?? result;
          loadedExtensions = selected.extensions.map(({ resolvedPath }) => ({ resolvedPath }));
          return selected;
        },
      };
    },
  };
}

function isRegistration(value: unknown): value is DesktopViewRegistrationEvent {
  if (typeof value !== "object" || value === null || !("declaration" in value)) return false;
  const declaration = value.declaration;
  return (
    typeof declaration === "object" &&
    declaration !== null &&
    "id" in declaration &&
    typeof declaration.id === "string" &&
    "title" in declaration &&
    typeof declaration.title === "string" &&
    "source" in declaration &&
    typeof declaration.source === "string" &&
    "frontend" in declaration &&
    (typeof declaration.frontend === "string" || declaration.frontend instanceof URL) &&
    "backend" in declaration &&
    typeof declaration.backend === "function" &&
    (!("accept" in value) || value.accept === undefined || typeof value.accept === "function")
  );
}
