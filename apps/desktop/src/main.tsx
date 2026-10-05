import React from "react";
import ReactDOM from "react-dom/client";
import { earlyModifierChords, getSidePanelTabCommand } from "../contracts/ipc";
import App from "./app/App";
import { RendererErrorBoundary } from "./app/desktop-recovery";
import { applyLastTheme } from "./ui/active-theme";
import { installTestHostTransport, testHostUrl } from "./platform/testhost-transport";
import "./dev-reload-hook";
import "./styles.css";

window.addEventListener(
  "keydown",
  (event) => {
    // Control+digit on macOS selects a side panel tab, not a thread; main queues it.
    const platform = window.piApp?.platform ?? "linux";
    const chord = {
      meta: event.metaKey,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    };
    if (getSidePanelTabCommand(platform, chord)) return;
    earlyModifierChords.note({
      modifier: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    });
  },
  true,
);

applyLastTheme();

function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RendererErrorBoundary
        onRelaunch={() => {
          window.piApp?.relaunchApplication()?.catch((error: unknown) => {
            console.error("[renderer] relaunchApplication failed", error);
          });
        }}
      >
        <App />
      </RendererErrorBoundary>
    </React.StrictMode>,
  );
}

// In the Rust test host, `window.piApp` arrives over a WebSocket before the app mounts.
const testHost = testHostUrl();
if (testHost) {
  installTestHostTransport(testHost).then(mount, (error: unknown) => {
    console.error("[renderer] test host connection failed", error);
  });
} else {
  mount();
}
