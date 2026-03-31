import { useEffect, useState, type KeyboardEvent } from "react";
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
import type { SettingsSection } from "../settings-view";
import type { Dispatch, SetStateAction } from "react";

interface ActiveSlashFlow {
  readonly command: ComposerSlashCommand;
}

export function nextMenuIndex(current: number, delta: number, total: number): number {
  if (!total) {
    return 0;
  }
  return (current + delta + total) % total;
}

interface UseSlashMenuParams {
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly selectedRuntime: RuntimeSnapshot | undefined;
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
  } = params;

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashOptionIndex, setSlashOptionIndex] = useState(0);
  const [activeSlashFlow, setActiveSlashFlow] = useState<ActiveSlashFlow | undefined>();
  const [slashMenuSuppressedDraft, setSlashMenuSuppressedDraft] = useState("");

  // Derived state
  const slashQuery = composerDraft.trimStart();
  const slashSections =
    slashQuery.startsWith("/")
      ? buildSlashCommandSections(slashQuery, selectedRuntime, sessionCommands, commandCompatibility)
      : [];
  const slashSuggestions = flattenSlashSections(slashSections);
  const exactSlashCommand = slashSuggestions.find((cmd) => isExactSlashCommand(slashQuery, cmd));
  const activeSlashOptionCommand =
    activeSlashFlow?.command ?? (exactSlashCommand?.submitMode === "pick-option" ? exactSlashCommand : undefined);
  const showSlashMenu =
    !isRunning &&
    slashQuery.startsWith("/") &&
    !slashQuery.includes("\n") &&
    !activeSlashOptionCommand &&
    slashQuery !== slashMenuSuppressedDraft &&
    slashSuggestions.length > 0;
  const selectedSlashCommand = showSlashMenu ? slashSuggestions[slashIndex % slashSuggestions.length] : undefined;
  const slashOptions =
    activeSlashOptionCommand?.kind === "model"
      ? buildModelOptions(selectedRuntime)
      : slashOptionsForCommand(activeSlashOptionCommand, selectedRuntime);
  const activeSlashOptionEmptyState = slashOptionEmptyState(activeSlashOptionCommand, selectedRuntime);
  const showSlashOptionMenu =
    !isRunning &&
    Boolean(activeSlashOptionCommand) &&
    (slashOptions.length > 0 || Boolean(activeSlashOptionEmptyState));
  const selectedSlashOption = showSlashOptionMenu ? slashOptions[slashOptionIndex % slashOptions.length] : undefined;

  // Reset slashIndex when slashQuery changes
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // Clear suppression when query diverges from suppressed draft
  useEffect(() => {
    if (slashMenuSuppressedDraft && slashQuery !== slashMenuSuppressedDraft) {
      setSlashMenuSuppressedDraft("");
    }
  }, [slashMenuSuppressedDraft, slashQuery]);

  // Exit slash flow when query invalidates it
  useEffect(() => {
    if (!slashQuery.startsWith("/")) {
      if (!slashQuery && activeSlashFlow) {
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
  }, [activeSlashFlow, slashQuery]);

  // Reset slash UI on session switch
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
    setComposerDraft(draft);
    setSlashMenuSuppressedDraft(options?.suppressMenu ? draft : "");
    focusComposer();
  };

  const openSlashOptionMenu = (command: ComposerSlashCommand) => {
    setSlashMenuSuppressedDraft("");
    setActiveSlashFlow({ command });
    setSlashOptionIndex(0);
    setComposerDraft("");
    focusComposer();
  };

  const applySlashCommandSelection = (
    command: ComposerSlashCommand,
    mode: "click" | "tab" | "enter",
  ) => {
    const submitMode = command.submitMode ?? "prefill";
    if (submitMode === "pick-option") {
      openSlashOptionMenu(command);
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
      if (mode === "enter") {
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
    if (!activeSlashOptionCommand || !selectedWorkspace || !api) {
      return;
    }

    if (activeSlashOptionCommand.kind === "model") {
      if (!selectedSession) {
        return;
      }
      resetSlashUi();
      setComposerDraft("");
      const modelOption = option as Extract<ComposerSlashOption, { value: string }> & { providerId?: string };
      const providerId = modelOption.providerId;
      if (!providerId) {
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
      if (!selectedSession) {
        return;
      }
      resetSlashUi();
      setComposerDraft("");
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
      void updateSnapshot(api, setSnapshot, () => api.loginProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "logout") {
      resetSlashUi();
      setComposerDraft("");
      void updateSnapshot(api, setSnapshot, () => api.logoutProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    closeSlashOptionMenu();
    fillComposerFromSlash(`${activeSlashOptionCommand.command} ${option.value}`);
  };

  /**
   * Handle slash-menu-related key events in the composer.
   * Returns `true` if the event was consumed (caller should not process further).
   */
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
    slashOptionEmptyState: activeSlashOptionEmptyState,
    activeSlashFlow,
    activeSlashOptionCommand,
    resetSlashUi,
    applySlashCommandSelection,
    applySlashOptionSelection,
    handleSlashKeyDown,
    fillComposerFromSlash,
  };
}
