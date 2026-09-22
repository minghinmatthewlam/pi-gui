import type { Facet } from "@earendil-works/chord";

export const DESKTOP_VIEW_REGISTER = "pi-gui:desktop-view:register";
export const DESKTOP_VIEW_DISCOVER = "pi-gui:desktop-view:discover";
export const DESKTOP_VIEW_UNREGISTER = "pi-gui:desktop-view:unregister";

/** Trusted, in-process declaration. Never serialize a backend factory to a browser. */
export interface DesktopViewDeclaration {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly frontend: string | URL;
  readonly backend: () => Facet;
}

export interface DesktopViewRegistrationEvent {
  readonly declaration: DesktopViewDeclaration;
  /** Acknowledges discovery only; asset validation and activation happen later. */
  readonly accept?: () => void;
}

/** Structural subset of the public Pi extension API; no runtime Pi import. */
export interface DesktopExtensionAPI {
  readonly events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  on(event: "session_shutdown", handler: () => void): void;
}

export interface DesktopViewRegistration {
  /** Whether a desktop host acknowledged this declaration; false in terminal Pi. */
  readonly available: boolean;
  dispose(): void;
}

/** Registers and replays the same declaration without re-running its backend factory. */
export function registerDesktopView(
  pi: DesktopExtensionAPI,
  declaration: DesktopViewDeclaration,
): DesktopViewRegistration {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(declaration.id)) {
    throw new TypeError("Desktop view ID must be a lowercase identifier of at most 64 characters");
  }
  if (!declaration.title.trim() || declaration.title.length > 120) {
    throw new TypeError("Desktop view title must contain 1 to 120 characters");
  }
  let available = false;
  let disposed = false;
  const publish = () => {
    if (disposed) return;
    pi.events.emit(DESKTOP_VIEW_REGISTER, {
      declaration,
      accept: () => {
        if (!disposed) available = true;
      },
    } satisfies DesktopViewRegistrationEvent);
  };
  const stopDiscovery = pi.events.on(DESKTOP_VIEW_DISCOVER, publish);
  const registration: DesktopViewRegistration = {
    get available() {
      return available;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      available = false;
      stopDiscovery();
      pi.events.emit(DESKTOP_VIEW_UNREGISTER, declaration);
    },
  };
  pi.on("session_shutdown", () => registration.dispose());
  publish();
  return registration;
}
