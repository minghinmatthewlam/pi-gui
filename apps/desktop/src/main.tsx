import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { RendererErrorBoundary } from "./app/desktop-recovery";
import "./dev-reload-hook";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RendererErrorBoundary
      onRelaunch={() => {
        void window.piApp?.relaunchApplication();
      }}
    >
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
