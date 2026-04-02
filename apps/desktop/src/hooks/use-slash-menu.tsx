import { useEffect, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { DesktopAppState, ExtensionCommandCompatibilityRecord, SessionRecord, WorkspaceRecord } from "../desktop-state";
import {
  buildModelOptions,
  isExactSlashCommand,
  buildSlashCommandSections,
  flattenSlashSections,
  slashOptionEmptyState,
  slashOptionsForCommand,
  type ComposerSlashCommand,
  type ComposerSlashCommandSection,
  type ComposerSlashOptionEmptyState,
  type ComposerSlashOption,
} from "../composer-commands";
import type { PiDesktopApi } from "../ipc";
import { deriveModelOnboardingState } from "../model-onboarding";
import type { SettingsSection } from "../settings-view";

interface ActiveSlashFlow {
  readonly command: ComposerSlashCommand;
}

interface ActiveSlashQuery {
  readonly query: string;
  readonly start: number;
  readonly end: number;
  readonly isPrimary: boolean;
}

export function nextMenuIndex(current: number, delta: number, total: number): number {
  if (!total) {
    return 0;
  }
  return (current + delta + total) % total;
}

function extractActiveSlashQuery(text: string): ActiveSlashQuery | undefined {
  const match = /\/[^\s]*$/.exec(text);
  if (!match || match.index < 0) {
    return undefined;
  }

  const query = match[0];
  const start = match.index;
  const prefix = text.slice(0, start);
  return {
    query,
    start,
    end: start + query.length,
    isPrimary: prefix.trim().length === 0,
  };
}

interface UseSlashMenuParams {
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly selectedRuntime: RuntimeSnapshot | undefined;
  readonly selectedModelRuntime: RuntimeSnapshot | undefined;
  readonly sessionCommands: readonly RuntimeCommandRecord[];
  readonly commandCompatibility: readonly ExtensionCommandCompatibilityRecord[];
  readonly selectedSessionKey: string;
  readonly selectedSession: SessionRecord | undefined;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly isRunning: boolean;
  readonly api: PiDesktopApi | undefined;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly focusComposer: () => void;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly immediateCommandMode?: "submit" | "prefill";
  readonly onSelectModelOption?: (provider: string, modelId: string) => void;
  readonly onSelectThinkingOption?: (level: string) => void;
  readonly onSelectLoginProvider?: (providerId: string) => void;
  readonly onSelectLogoutProvider?: (providerId: string) => void;
}

export interface SlashMenuState {
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashSuggestions: readonly ComposerSlashCommand[];
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly selectedSlashCommand: ComposerSlashCommand | undefined;
  readonly selectedSlashOption: ComposerSlashOption | undefined;
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly slashOptionEmptyState: ComposerSlashOptionEmptyState | undefined;
  readonly activeSlashFlow: ActiveSlashFlow | undefined;
  readonly activeSlashOptionCommand: ComposerSlashCommand | undefined;
  readonly resetSlashUi: () => void;
  readonly applySlashCommandSelection: (command: ComposerSlashCommand, mode: "click" | "tab" | "enter") => void;
  readonly applySlashOptionSelection: (option: ComposerSlashOption) => void;
  readonly handleSlashKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly fillComposerFromSlash: (draft: string, options?: { suppressMenu?: boolean }) => void;
}

export function useSlashMenu(params: UseSlashMenuParams): SlashMenuState {
  const {
    composerDraft,
    setComposerDraft,
    selectedRuntime,
    selectedModelRuntime,
    sessionCommands,
    commandCompatibility,
    selectedSessionKey,
    selectedSession,
    selectedWorkspace,
    isRunning,
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    immediateCommandMode = "submit",
    onSelectModelOption,
    onSelectThinkingOption,
    onSelectLoginProvider,
    onSelectLogoutProvider,
  } = params;

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashOptionIndex, setSlashOptionIndex] = useState(0);
  const [activeSlashFlow, setActiveSlashFlow] = useState<ActiveSlashFlow | undefined>();
  const [slashMenuSuppressedDraft, setSlashMenuSuppressedDraft] = useState("");

  const activeSlashQuery = extractActiveSlashQuery(composerDraft);
  const slashQuery = activeSlashQuery?.query ?? "";
  const slashSections =
    activeSlashQuery
      ? buildSlashCommandSections(slashQuery, selectedRuntime, sessionCommands, commandCompatibility)
      : [];
  const slashSuggestions = flattenSlashSections(slashSections);
  const exactSlashCommand = slashSuggestions.find((cmd) => isExactSlashCommand(slashQuery, cmd));
  const activeSlashOptionCommand =
    activeSlashFlow?.command ?? (exactSlashCommand?.submitMode === "pick-option" ? exactSlashCommand : undefined);
  const showSlashMenu =
    !isRunning &&
    Boolean(activeSlashQuery) &&
    !activeSlashOptionCommand &&
    composerDraft !== slashMenuSuppressedDraft &&
    slashSuggestions.length > 0;
  const selectedSlashCommand = showSlashMenu ? slashSuggestions[slashIndex % slashSuggestions.length] : undefined;
  const slashOptions =
    activeSlashOptionCommand?.kind === "model"
      ? buildModelOptions(selectedModelRuntime)
      : slashOptionsForCommand(activeSlashOptionCommand, selectedRuntime);
  const activeSlashOptionEmptyState = slashOptionEmptyState(
    activeSlashOptionCommand,
    activeSlashOptionCommand?.kind === "model"
      ? undefined
      : selectedRuntime,
  );
  const modelSlashEmptyState =
    activeSlashOptionCommand?.kind === "model" && slashOptions.length === 0
      ? (() => {
          const state = deriveModelOnboardingState(selectedModelRuntime, {
            provider: undefined,
            modelId: undefined,
          });
          return {
            title: state.emptyModelTitle,
            description: state.emptyModelDescription,
          };
        })()
      : undefined;
  const showSlashOptionMenu =
    !isRunning &&
    Boolean(activeSlashOptionCommand) &&
    (slashOptions.length > 0 || Boolean(modelSlashEmptyState ?? activeSlashOptionEmptyState));
  const selectedSlashOption = showSlashOptionMenu ? slashOptions[slashOptionIndex % slashOptions.length] : undefined;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashMenuSuppressedDraft && composerDraft !== slashMenuSuppressedDraft) {
      setSlashMenuSuppressedDraft("");
    }
  }, [composerDraft, slashMenuSuppressedDraft]);

  useEffect(() => {
    if (!activeSlashQuery) {
      if (!composerDraft.trim() && activeSlashFlow) {
        return;
      }
      setActiveSlashFlow(undefined);
      setSlashOptionIndex(0);
      return;
    }

    if (activeSlashFlow?.command && slashQuery.trim().length > activeSlashFlow.command.command.length) {
      setActiveSlashFlow(undefined);
      setSlashOptionIndex(0);
    }
  }, [activeSlashFlow, activeSlashQuery, slashQuery]);

  useEffect(() => {
    setActiveSlashFlow(undefined);
    setSlashOptionIndex(0);
    setSlashMenuSuppressedDraft("");
  }, [selectedSessionKey]);

  const closeSlashOptionMenu = () => {
    setActiveSlashFlow(undefined);
    setSlashOptionIndex(0);
  };

  const resetSlashUi = () => {
    closeSlashOptionMenu();
    setSlashMenuSuppressedDraft("");
  };

  const fillComposerFromSlash = (draft: string, options?: { suppressMenu?: boolean }) => {
    const nextDraft = activeSlashQuery
      ? `${composerDraft.slice(0, activeSlashQuery.start)}${draft}${composerDraft.slice(activeSlashQuery.end)}`
      : draft;
    setComposerDraft(nextDraft);
    setSlashMenuSuppressedDraft(options?.suppressMenu ? nextDraft : "");
    focusComposer();
  };

  const openSlashOptionMenu = (command: ComposerSlashCommand) => {
    if (!activeSlashQuery?.isPrimary) {
      closeSlashOptionMenu();
      fillComposerFromSlash(command.command);
      return;
    }
    setSlashMenuSuppressedDraft("");
    setActiveSlashFlow({ command });
    setSlashOptionIndex(0);
    setComposerDraft("");
    focusComposer();
  };

  const applySlashCommandSelection = (command: ComposerSlashCommand, mode: "click" | "tab" | "enter") => {
    const submitMode = command.submitMode ?? "prefill";
    if (submitMode === "pick-option") {
      openSlashOptionMenu(command);
      return;
    }

    if (!activeSlashQuery?.isPrimary) {
      closeSlashOptionMenu();
      fillComposerFromSlash(submitMode === "prefill" ? command.template : command.command, { suppressMenu: true });
      return;
    }

    if (command.kind === "settings" || command.kind === "scoped-models") {
      resetSlashUi();
      setComposerDraft("");
      openSettings(
        selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id,
        command.kind === "scoped-models" ? "models" : undefined,
      );
      return;
    }

    if (submitMode === "immediate") {
      if (mode === "enter" && immediateCommandMode === "submit") {
        if (!api) {
          return;
        }
        resetSlashUi();
        setComposerDraft(command.command);
        void updateSnapshot(api, setSnapshot, () => api.submitComposer(command.command)).then((state) => {
          setComposerDraft(state.composerDraft);
        });
        return;
      }

      closeSlashOptionMenu();
      fillComposerFromSlash(command.command, { suppressMenu: true });
      return;
    }

    closeSlashOptionMenu();
    fillComposerFromSlash(command.template, { suppressMenu: true });
  };

  const applySlashOptionSelection = (option: ComposerSlashOption) => {
    if (!activeSlashOptionCommand) {
      return;
    }

    if (!activeSlashQuery?.isPrimary) {
      closeSlashOptionMenu();
      fillComposerFromSlash(`${activeSlashOptionCommand.command} ${option.value}`, { suppressMenu: true });
      return;
    }

    if (activeSlashOptionCommand.kind === "model") {
      const modelOption = option as Extract<ComposerSlashOption, { value: string }> & { providerId?: string };
      const providerId = modelOption.providerId;
      if (!providerId) {
        return;
      }
      resetSlashUi();
      setComposerDraft("");
      if (onSelectModelOption) {
        onSelectModelOption(providerId, option.value);
        return;
      }
      if (!selectedWorkspace || !selectedSession || !api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () =>
        api.setSessionModel(selectedWorkspace.id, selectedSession.id, providerId, option.value),
      ).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "thinking") {
      resetSlashUi();
      setComposerDraft("");
      if (onSelectThinkingOption) {
        onSelectThinkingOption(option.value);
        return;
      }
      if (!selectedWorkspace || !selectedSession || !api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () =>
        api.setSessionThinkingLevel(
          selectedWorkspace.id,
          selectedSession.id,
          option.value as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
        ),
      ).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "login") {
      resetSlashUi();
      setComposerDraft("");
      if (onSelectLoginProvider) {
        onSelectLoginProvider(option.value);
        return;
      }
      if (!selectedWorkspace || !api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.loginProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "logout") {
      resetSlashUi();
      setComposerDraft("");
      if (onSelectLogoutProvider) {
        onSelectLogoutProvider(option.value);
        return;
      }
      if (!selectedWorkspace || !api) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.logoutProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    closeSlashOptionMenu();
    fillComposerFromSlash(`${activeSlashOptionCommand.command} ${option.value}`);
  };

  const handleSlashKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((showSlashMenu || showSlashOptionMenu) && event.key === "Escape") {
      event.preventDefault();
      resetSlashUi();
      return true;
    }

    if (showSlashOptionMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setSlashOptionIndex((current) => nextMenuIndex(current, event.key === "ArrowDown" ? 1 : -1, slashOptions.length));
      return true;
    }

    if (showSlashOptionMenu && (event.key === "Tab" || event.key === "Enter") && selectedSlashOption) {
      event.preventDefault();
      applySlashOptionSelection(selectedSlashOption);
      return true;
    }

    if (showSlashMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setSlashIndex((current) => nextMenuIndex(current, event.key === "ArrowDown" ? 1 : -1, slashSuggestions.length));
      return true;
    }

    if (showSlashMenu && event.key === "Tab" && selectedSlashCommand) {
      event.preventDefault();
      applySlashCommandSelection(selectedSlashCommand, "tab");
      return true;
    }

    if (showSlashMenu && event.key === "Enter" && selectedSlashCommand && !slashQuery.includes(" ")) {
      event.preventDefault();
      applySlashCommandSelection(selectedSlashCommand, "enter");
      return true;
    }

    return false;
  };

  return {
    slashSections,
    slashSuggestions,
    showSlashMenu,
    showSlashOptionMenu,
    selectedSlashCommand,
    selectedSlashOption,
    slashOptions,
    slashOptionEmptyState: modelSlashEmptyState ?? activeSlashOptionEmptyState,
    activeSlashFlow,
    activeSlashOptionCommand,
    resetSlashUi,
    applySlashCommandSelection,
    applySlashOptionSelection,
    handleSlashKeyDown,
    fillComposerFromSlash,
  };
}
