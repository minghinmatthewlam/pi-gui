import { useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, WorkspaceRecord } from "../../contracts/desktop-state";
import type { PiDesktopApi } from "../../contracts/ipc";
import type { SettingsSection } from "../features/settings/settings-view";
import type { AppLocation } from "./navigation-history";
import { updateSnapshot } from "./desktop-app-state";
import { useNavigationHistory } from "./use-navigation-history";

interface AppNavigationInput {
  api: PiDesktopApi | undefined;
  snapshot: DesktopAppState | null;
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  rootWorkspaceOptions: readonly WorkspaceRecord[];
  flushComposerDraft: () => void;
  savePosition: () => void;
  closeSearch: () => void;
}

export function useAppNavigation({
  api,
  snapshot,
  setSnapshot,
  rootWorkspaceOptions,
  flushComposerDraft,
  savePosition,
  closeSearch,
}: AppNavigationInput) {
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
    if (!api) {
      return;
    }
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : settingsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSettingsWorkspaceId(nextWorkspaceId);
    }
    if (section) {
      setSettingsSection(section);
    }
    void updateSnapshot(setSnapshot, () => api.setActiveView("settings")).catch(
      (error: unknown) => {
        console.error("[renderer] setActiveView failed", error);
      },
    );
  };

  const location: AppLocation | null = snapshot
    ? snapshot.activeView === "settings"
      ? { view: "settings", workspaceId: settingsWorkspaceId, section: settingsSection }
      : snapshot.activeView === "skills"
        ? { view: "skills", workspaceId: skillsWorkspaceId }
        : snapshot.activeView === "extensions"
          ? { view: "extensions", workspaceId: extensionsWorkspaceId }
          : snapshot.activeView === "threads"
            ? {
                view: "threads",
                workspaceId: snapshot.selectedWorkspaceId,
                sessionId: snapshot.selectedSessionId,
              }
            : { view: snapshot.activeView }
    : null;
  const navigate = useNavigationHistory(
    location,
    async (destination) => {
      if (!api) return;
      flushComposerDraft();
      savePosition();
      closeSearch();
      if (destination.view === "settings") {
        setSettingsWorkspaceId(destination.workspaceId ?? "");
        setSettingsSection(destination.section ?? "general");
      } else if (destination.view === "skills") {
        setSkillsWorkspaceId(destination.workspaceId ?? "");
      } else if (destination.view === "extensions") {
        setExtensionsWorkspaceId(destination.workspaceId ?? "");
      }
      if (destination.view === "threads" && destination.workspaceId && destination.sessionId) {
        const target = { workspaceId: destination.workspaceId, sessionId: destination.sessionId };
        await updateSnapshot(setSnapshot, () => api.selectSession(target));
      } else {
        await updateSnapshot(setSnapshot, () => api.setActiveView(destination.view));
      }
    },
    (destination) => {
      if (!destination.workspaceId) return true;
      const workspace = snapshot?.workspaces.find((entry) => entry.id === destination.workspaceId);
      return Boolean(
        workspace &&
        (!destination.sessionId ||
          workspace.sessions.some(
            (session) => session.id === destination.sessionId && !session.archivedAt,
          )),
      );
    },
  );
  return {
    settingsSection,
    setSettingsSection,
    settingsWorkspaceId,
    setSettingsWorkspaceId,
    skillsWorkspaceId,
    setSkillsWorkspaceId,
    extensionsWorkspaceId,
    setExtensionsWorkspaceId,
    openSettings,
    navigate,
  };
}
