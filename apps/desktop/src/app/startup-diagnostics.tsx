import type { StartupDiagnostic } from "../../contracts/desktop-state";
import { useTranslation } from "../i18n";

interface StartupDiagnosticsProps {
  readonly diagnostics: readonly StartupDiagnostic[];
}

/**
 * Failures the main process reported before the window could talk to it. They sit
 * under the topbar so a workspace that never loaded is visible in every view.
 */
export function StartupDiagnostics({ diagnostics }: StartupDiagnosticsProps) {
  const { t } = useTranslation();
  if (diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="startup-diagnostics" role="status" data-testid="startup-diagnostics">
      <strong>{t("app.startupDiagnostics.title")}</strong>
      <span>
        {diagnostics
          .map((diagnostic) => {
            const workspaceName = diagnostic.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1);
            return workspaceName
              ? t("app.startupDiagnostics.workspaceUnavailable", { workspace: workspaceName })
              : diagnostic.message;
          })
          .join(" ")}
      </span>
    </div>
  );
}
