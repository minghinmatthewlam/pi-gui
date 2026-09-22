import React from "react";
import ReactDOM from "react-dom/client";
import { earlyModifierChords } from "../contracts/ipc";
import App from "./app/App";
import { RendererErrorBoundary } from "./app/desktop-recovery";
import "./dev-reload-hook";
import "./styles.css";

window.addEventListener(
  "keydown",
  (event) => {
    earlyModifierChords.note({
      modifier: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    });
  },
  true,
);

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
