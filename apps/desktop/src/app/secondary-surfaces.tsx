import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { AppView, DesktopAppState, WorkspaceRecord } from "../../contracts/desktop-state";
import { updateSnapshot } from "./desktop-app-state";
import { getEffectiveModelRuntime } from "../features/settings/model-settings";
import {
  type CustomProviderConfig,
  type DesktopNotificationPermissionStatus,
} from "../../contracts/ipc";
import { CustomizePage } from "../features/extensions/customize-page";
import { SettingsView, type SettingsSection } from "../features/settings/settings-view";
import {
  CUSTOMIZE_SECTION_ID,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTIONS,
} from "../features/settings/settings-sections";
import { SettingsSelect } from "../features/settings/settings-controls";
import { SecondarySurface } from "./secondary-surface";

interface SecondarySurfacesProps {
  readonly api: NonNullable<typeof window.piApp>;
  readonly snapshot: DesktopAppState;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly activeView: Extract<AppView, "settings" | "skills" | "extensions">;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly settingsSection: SettingsSection;
  readonly onSelectSettingsSection: (section: SettingsSection) => void;
  readonly settingsWorkspaceId: string;
  readonly onSelectSettingsWorkspace: (workspaceId: string) => void;
  readonly skillsWorkspaceId: string;
  readonly onSelectSkillsWorkspace: (workspaceId: string) => void;
  readonly extensionsWorkspaceId: string;
  readonly onSelectExtensionsWorkspace: (workspaceId: string) => void;
  readonly onBack: () => void;
  /** Settings and the Skills and extensions page are separate app views. */
  readonly onSelectView: (view: Extract<AppView, "settings" | "skills" | "extensions">) => void;
  readonly onTrySkill: (command: string) => void;
}

export function SecondarySurfaces({
  api,
  snapshot,
  setSnapshot,
  activeView,
  rootWorkspaceOptions,
  settingsSection,
  onSelectSettingsSection,
  settingsWorkspaceId,
  onSelectSettingsWorkspace,
  skillsWorkspaceId,
  onSelectSkillsWorkspace,
  extensionsWorkspaceId,
  onSelectExtensionsWorkspace,
  onBack,
  onSelectView,
  onTrySkill,
}: SecondarySurfacesProps) {
  const [notificationPermissionStatus, setNotificationPermissionStatus] =
    useState<DesktopNotificationPermissionStatus>("unknown");
  const [notificationPermissionPending, setNotificationPermissionPending] = useState(false);

  const settingsWorkspace = settingsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId)
    : undefined;
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const extensionsWorkspace = extensionsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === extensionsWorkspaceId)
    : undefined;
  const settingsRuntime = settingsWorkspace
    ? snapshot.runtimeByWorkspace[settingsWorkspace.id]
    : undefined;
  const settingsModelRuntime = getEffectiveModelRuntime(snapshot, settingsWorkspace);
  const skillsRuntime = skillsWorkspace
    ? snapshot.runtimeByWorkspace[skillsWorkspace.id]
    : undefined;
  const extensionsRuntime = extensionsWorkspace
    ? snapshot.runtimeByWorkspace[extensionsWorkspace.id]
    : undefined;
  const extensionsCommandCompatibility = extensionsWorkspace
    ? (snapshot.extensionCommandCompatibilityByWorkspace[extensionsWorkspace.id] ?? [])
    : [];

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi?.onNotificationPermissionStatusChanged) {
      return;
    }
    return piApi.onNotificationPermissionStatusChanged((status) => {
      setNotificationPermissionStatus(status);
    });
  }, []);

  const refreshNotificationPermissionStatus = useCallback(() => {
    if (!api.getNotificationPermissionStatus) {
      return Promise.resolve("unknown" as DesktopNotificationPermissionStatus);
    }
    return api.getNotificationPermissionStatus().then((status) => {
      setNotificationPermissionStatus(status);
      return status;
    });
  }, [api]);

  useEffect(() => {
    if (activeView !== "settings" || settingsSection !== "notifications") {
      return;
    }
    void refreshNotificationPermissionStatus().catch((error: unknown) => {
      console.error("[renderer] refreshNotificationPermissionStatus failed", error);
    });
  }, [activeView, refreshNotificationPermissionStatus, settingsSection]);

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setDefaultModel(settingsWorkspace.id, provider, modelId),
    ).catch((error: unknown) => {
      console.error("[renderer] setDefaultModel failed", error);
    });
  };

  const handleSetThinkingLevel = (
    thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"],
  ) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setDefaultThinkingLevel(settingsWorkspace.id, thinkingLevel),
    ).catch((error: unknown) => {
      console.error("[renderer] setDefaultThinkingLevel failed", error);
    });
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setEnableSkillCommands(settingsWorkspace.id, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setEnableSkillCommands failed", error);
    });
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setScopedModelPatterns(settingsWorkspace.id, patterns),
    ).catch((error: unknown) => {
      console.error("[renderer] setScopedModelPatterns failed", error);
    });
  };

  const handleSetModelSettingsScopeMode = (mode: "app-global" | "per-repo") => {
    void updateSnapshot(setSnapshot, () => api.setModelSettingsScopeMode(mode)).catch(
      (error: unknown) => {
        console.error("[renderer] setModelSettingsScopeMode failed", error);
      },
    );
  };

  const handleLoginProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.loginProvider(settingsWorkspace.id, providerId),
    ).catch((error: unknown) => {
      console.error("[renderer] loginProvider failed", error);
    });
  };

  const handleLogoutProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.logoutProvider(settingsWorkspace.id, providerId),
    ).catch((error: unknown) => {
      console.error("[renderer] logoutProvider failed", error);
    });
  };

  const handleSetProviderApiKey = async (
    providerId: string,
    apiKey: string,
  ): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.setProviderApiKey(settingsWorkspace.id, providerId, apiKey),
    );
    return state.lastError;
  };

  const handleRemoveProviderApiKey = async (providerId: string): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.logoutProvider(settingsWorkspace.id, providerId),
    );
    return state.lastError;
  };

  const handleSaveCustomProvider = async (
    config: CustomProviderConfig,
  ): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.setCustomProvider(settingsWorkspace.id, config),
    );
    return state.lastError;
  };

  const handleDeleteCustomProvider = async (providerId: string): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.deleteCustomProvider(settingsWorkspace.id, providerId),
    );
    return state.lastError;
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!skillsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setSkillEnabled(skillsWorkspace.id, filePath, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setSkillEnabled failed", error);
    });
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!skillsWorkspace) {
      return;
    }
    void api.openSkillInFinder(skillsWorkspace.id, filePath).catch((error: unknown) => {
      console.error("[renderer] openSkillInFinder failed", error);
    });
  };

  const handleToggleExtension = (filePath: string, enabled: boolean) => {
    if (!extensionsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setExtensionEnabled(extensionsWorkspace.id, filePath, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setExtensionEnabled failed", error);
    });
  };

  const handleOpenExtensionFolder = (filePath: string) => {
    if (!extensionsWorkspace) {
      return;
    }
    void api.openExtensionInFinder(extensionsWorkspace.id, filePath).catch((error: unknown) => {
      console.error("[renderer] openExtensionInFinder failed", error);
    });
  };

  const handleSetThemeMode = (mode: "system" | "light" | "dark") => {
    void updateSnapshot(setSnapshot, () => api.setThemeMode(mode)).catch((error: unknown) => {
      console.error("[renderer] setThemeMode failed", error);
    });
  };

  const handleSetThemePresetId = (presetId: DesktopAppState["themePresetId"]) => {
    void updateSnapshot(setSnapshot, () => api.setThemePresetId(presetId)).catch(
      (error: unknown) => {
        console.error("[renderer] setThemePresetId failed", error);
      },
    );
  };

  const handleSetNotificationPreferences = (
    preferences: Partial<DesktopAppState["notificationPreferences"]>,
  ) => {
    void updateSnapshot(setSnapshot, () => api.setNotificationPreferences(preferences)).catch(
      (error: unknown) => {
        console.error("[renderer] setNotificationPreferences failed", error);
      },
    );
  };

  const handleSetIntegratedTerminalShell = (shellPath: string) => {
    void updateSnapshot(setSnapshot, () => api.setIntegratedTerminalShell(shellPath)).catch(
      (error: unknown) => {
        console.error("[renderer] setIntegratedTerminalShell failed", error);
      },
    );
  };

  const handleRequestNotificationPermission = () => {
    if (!api.requestNotificationPermission) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .requestNotificationPermission()
      .then((status) => {
        setNotificationPermissionStatus(status);
      })
      .finally(() => {
        setNotificationPermissionPending(false);
      })
      .catch((error: unknown) => {
        console.error("[renderer] api failed", error);
      });
  };

  const handleOpenSystemNotificationSettings = () => {
    if (!api.openSystemNotificationSettings) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .openSystemNotificationSettings()
      .finally(() => {
        setNotificationPermissionPending(false);
      })
      .catch((error: unknown) => {
        console.error("[renderer] openSystemNotificationSettings failed", error);
      });
  };

  const customizeTab = activeView === "settings" ? undefined : activeView;
  const customizeWorkspace = customizeTab === "extensions" ? extensionsWorkspace : skillsWorkspace;
  const workspacePicker = (
    value: WorkspaceRecord | undefined,
    onChange: (workspaceId: string) => void,
  ) =>
    rootWorkspaceOptions.length > 0 ? (
      <SettingsSelect
        label="Workspace"
        options={rootWorkspaceOptions.map((workspace) => ({
          value: workspace.id,
          label: workspace.name,
        }))}
        value={value?.id}
        onChange={onChange}
      />
    ) : null;

  return (
    <SecondarySurface
      activeNavId={customizeTab ? CUSTOMIZE_SECTION_ID : settingsSection}
      navItems={SETTINGS_NAV_ITEMS}
      onBack={onBack}
      onSelectNav={(id) => {
        if (id === CUSTOMIZE_SECTION_ID) {
          if (!customizeTab) onSelectView("skills");
          return;
        }
        const section = SETTINGS_SECTIONS.find((definition) => definition.id === id);
        if (!section) return;
        onSelectSettingsSection(section.id);
        if (customizeTab) onSelectView("settings");
      }}
      testId={customizeTab ? `${customizeTab}-surface` : "settings-surface"}
      title="Settings"
    >
      {customizeTab ? (
        <CustomizePage
          commandCompatibility={extensionsCommandCompatibility}
          extensionsRuntime={extensionsRuntime}
          skillsRuntime={skillsRuntime}
          tab={customizeTab}
          workspace={customizeWorkspace}
          workspacePicker={
            customizeTab === "extensions"
              ? workspacePicker(extensionsWorkspace, onSelectExtensionsWorkspace)
              : workspacePicker(skillsWorkspace, onSelectSkillsWorkspace)
          }
          onOpenExtensionFolder={handleOpenExtensionFolder}
          onOpenSkillFolder={handleOpenSkillFolder}
          onRefresh={() => {
            if (!customizeWorkspace) return;
            void updateSnapshot(setSnapshot, () => api.refreshRuntime(customizeWorkspace.id)).catch(
              (error: unknown) => {
                console.error("[renderer] refreshRuntime failed", error);
              },
            );
          }}
          onSelectTab={onSelectView}
          onToggleExtension={handleToggleExtension}
          onToggleSkill={handleToggleSkill}
          onTryCommand={onTrySkill}
        />
      ) : (
        <SettingsView
          workspace={settingsWorkspace}
          runtime={settingsSection === "models" ? settingsModelRuntime : settingsRuntime}
          platform={api.platform}
          headerAccessory={
            settingsSection === "providers" ||
            (settingsSection === "models" && snapshot.modelSettingsScopeMode === "per-repo")
              ? workspacePicker(settingsWorkspace, onSelectSettingsWorkspace)
              : undefined
          }
          section={settingsSection}
          notificationPreferences={snapshot.notificationPreferences}
          notificationPermissionStatus={notificationPermissionStatus}
          notificationPermissionPending={notificationPermissionPending}
          modelSettingsScopeMode={snapshot.modelSettingsScopeMode}
          integratedTerminalShell={snapshot.integratedTerminalShell}
          themeMode={snapshot.themeMode}
          themePresetId={snapshot.themePresetId}
          enableTransparency={snapshot.enableTransparency}
          onLoginProvider={handleLoginProvider}
          onLogoutProvider={handleLogoutProvider}
          onSetProviderApiKey={handleSetProviderApiKey}
          onRemoveProviderApiKey={handleRemoveProviderApiKey}
          onSaveCustomProvider={handleSaveCustomProvider}
          onDeleteCustomProvider={handleDeleteCustomProvider}
          onSetModelSettingsScopeMode={handleSetModelSettingsScopeMode}
          onSetDefaultModel={handleSetDefaultModel}
          onSetNotificationPreferences={handleSetNotificationPreferences}
          onSetIntegratedTerminalShell={handleSetIntegratedTerminalShell}
          onRequestNotificationPermission={handleRequestNotificationPermission}
          onOpenSystemNotificationSettings={handleOpenSystemNotificationSettings}
          onSetScopedModelPatterns={handleSetScopedModelPatterns}
          onSetThemeMode={handleSetThemeMode}
          onSetThemePresetId={handleSetThemePresetId}
          onSetThinkingLevel={handleSetThinkingLevel}
          onToggleSkillCommands={handleToggleSkillCommands}
          onSetEnableTransparency={(enabled) => {
            void updateSnapshot(setSnapshot, () => api.setEnableTransparency(enabled)).catch(
              (error: unknown) => {
                console.error("[renderer] setEnableTransparency failed", error);
              },
            );
          }}
        />
      )}
    </SecondarySurface>
  );
}
