//! Every renderer method: its `PiDesktopApi` name, its `desktopIpc` channel, and how Electron
//! main dispatched it (`register-desktop-ipc.ts`). A unit test on the TypeScript side checks
//! this list against `desktopIpc` and the preload API.

/// How a method reaches the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `runStateAction`: queued behind other actions, on the sender's view.
    Queued,
    /// `runStateResultAction`: queued; the result carries a `state`.
    QueuedResult,
    /// `submitComposer`: queued when the text may change selection, else immediate.
    QueuedIfSenderView,
    /// `runImmediateStateAction`: not queued; the sender gets its state at once.
    Immediate,
    /// `runUnscopedStateAction`: not queued; the result is projected for the sender.
    Unscoped,
    /// Checks the sender is a live window, then answers directly.
    Checked,
    /// Only a window's main frame may call it (`mainFrameHandler`).
    MainFrame,
    /// Answered from the sender's view without other checks (state and transcript reads).
    Read,
    /// `ipcRenderer.send`: no answer.
    Send,
}

/// One renderer method.
#[derive(Debug, Clone, Copy)]
pub struct Method {
    pub api: &'static str,
    pub channel: &'static str,
    pub kind: Kind,
}

const fn m(api: &'static str, channel: &'static str, kind: Kind) -> Method {
    Method { api, channel, kind }
}

use Kind::*;

/// Every `PiDesktopApi` method that calls main, plus the preload's own draft acknowledgement.
pub const METHODS: &[Method] = &[
    m("ping", "app:ping", Checked),
    m("getState", "pi-gui:state-request", Read),
    m(
        "getTaskWorkbenchTemplate",
        "pi-gui:get-task-workbench-template",
        MainFrame,
    ),
    m(
        "saveTaskWorkbenchTemplate",
        "pi-gui:save-task-workbench-template",
        MainFrame,
    ),
    m(
        "listExtensionViews",
        "pi-gui:list-extension-views",
        MainFrame,
    ),
    m("openExtensionView", "pi-gui:open-extension-view", MainFrame),
    m(
        "sendExtensionViewMessage",
        "pi-gui:send-extension-view-message",
        MainFrame,
    ),
    m(
        "closeExtensionView",
        "pi-gui:close-extension-view",
        MainFrame,
    ),
    m(
        "runExtensionAction",
        "pi-gui:run-extension-action",
        MainFrame,
    ),
    m("getTurnChanges", "pi-gui:get-turn-changes", MainFrame),
    m("getReview", "pi-gui:get-review", MainFrame),
    m("getReviewFile", "pi-gui:get-review-file", MainFrame),
    m(
        "setReviewFileReviewed",
        "pi-gui:set-review-file-reviewed",
        MainFrame,
    ),
    m(
        "changeReviewFileStage",
        "pi-gui:change-review-file-stage",
        MainFrame,
    ),
    m(
        "getSelectedTranscript",
        "pi-gui:selected-transcript-request",
        Read,
    ),
    m("addWorkspacePath", "pi-gui:add-workspace-path", Queued),
    m("pickWorkspace", "pi-gui:pick-workspace", Checked),
    m("selectWorkspace", "pi-gui:select-workspace", Queued),
    m("renameWorkspace", "pi-gui:rename-workspace", Queued),
    m("removeWorkspace", "pi-gui:remove-workspace", Queued),
    m("reorderWorkspaces", "pi-gui:reorder-workspaces", Queued),
    m(
        "reorderPinnedSessions",
        "pi-gui:reorder-pinned-sessions",
        Queued,
    ),
    m(
        "openWorkspaceInFinder",
        "pi-gui:open-workspace-in-finder",
        Checked,
    ),
    m("createWorktree", "pi-gui:create-worktree", Queued),
    m("removeWorktree", "pi-gui:remove-worktree", Queued),
    m("openSkillInFinder", "pi-gui:open-skill-in-finder", Checked),
    m(
        "openExtensionInFinder",
        "pi-gui:open-extension-in-finder",
        Checked,
    ),
    m(
        "syncCurrentWorkspace",
        "pi-gui:sync-current-workspace",
        Queued,
    ),
    m("selectSession", "pi-gui:select-session", Queued),
    m("renameSession", "pi-gui:rename-session", Queued),
    m("archiveSession", "pi-gui:archive-session", Queued),
    m("unarchiveSession", "pi-gui:unarchive-session", Queued),
    m("markSessionRead", "pi-gui:mark-session-read", Queued),
    m("setSessionPinned", "pi-gui:set-session-pinned", Immediate),
    m("createSession", "pi-gui:create-session", Queued),
    m("startThread", "pi-gui:start-thread", Queued),
    m("forkThread", "pi-gui:fork-thread", Queued),
    m(
        "sendChildThreadFollowUp",
        "pi-gui:send-child-thread-follow-up",
        Queued,
    ),
    m(
        "setChildSupervisionLoop",
        "pi-gui:set-child-supervision-loop",
        Queued,
    ),
    m(
        "createScheduledTask",
        "pi-gui:create-scheduled-task",
        Queued,
    ),
    m(
        "updateScheduledTask",
        "pi-gui:update-scheduled-task",
        Queued,
    ),
    m(
        "deleteScheduledTask",
        "pi-gui:delete-scheduled-task",
        Queued,
    ),
    m(
        "beginScheduledTaskInterview",
        "pi-gui:begin-scheduled-task-interview",
        Queued,
    ),
    m("cancelCurrentRun", "pi-gui:cancel-current-run", Immediate),
    m("setActiveView", "pi-gui:set-active-view", Queued),
    m(
        "setSidebarCollapsed",
        "pi-gui:set-sidebar-collapsed",
        Queued,
    ),
    m("setThreadGrouping", "pi-gui:set-thread-grouping", Queued),
    m(
        "setWorkspaceCollapsed",
        "pi-gui:set-workspace-collapsed",
        Queued,
    ),
    m("refreshRuntime", "pi-gui:refresh-runtime", Queued),
    m(
        "setModelSettingsScopeMode",
        "pi-gui:set-model-settings-scope-mode",
        Queued,
    ),
    m("setDefaultModel", "pi-gui:set-default-model", Queued),
    m(
        "setDefaultThinkingLevel",
        "pi-gui:set-default-thinking-level",
        Queued,
    ),
    m("setSessionModel", "pi-gui:set-session-model", Queued),
    m(
        "setSessionThinkingLevel",
        "pi-gui:set-session-thinking-level",
        Queued,
    ),
    m("loginProvider", "pi-gui:login-provider", Unscoped),
    m("logoutProvider", "pi-gui:logout-provider", Queued),
    m("setProviderApiKey", "pi-gui:set-provider-api-key", Queued),
    m(
        "listCustomProviders",
        "pi-gui:list-custom-providers",
        Checked,
    ),
    m("setCustomProvider", "pi-gui:set-custom-provider", Queued),
    m(
        "deleteCustomProvider",
        "pi-gui:delete-custom-provider",
        Queued,
    ),
    m(
        "probeCustomProviderModels",
        "pi-gui:probe-custom-provider-models",
        Checked,
    ),
    m(
        "setEnableSkillCommands",
        "pi-gui:set-enable-skill-commands",
        Queued,
    ),
    m(
        "setScopedModelPatterns",
        "pi-gui:set-scoped-model-patterns",
        Queued,
    ),
    m("setSkillEnabled", "pi-gui:set-skill-enabled", Queued),
    m(
        "setExtensionEnabled",
        "pi-gui:set-extension-enabled",
        Queued,
    ),
    m("listMcpServers", "pi-gui:list-mcp-servers", Checked),
    m("addMcpServer", "pi-gui:add-mcp-server", Queued),
    m("removeMcpServer", "pi-gui:remove-mcp-server", Queued),
    m(
        "setMcpServerEnabled",
        "pi-gui:set-mcp-server-enabled",
        Queued,
    ),
    m(
        "setCodemodeAlwaysOn",
        "pi-gui:set-codemode-always-on",
        Queued,
    ),
    m(
        "respondToHostUiRequest",
        "pi-gui:respond-to-host-ui-request",
        Immediate,
    ),
    m(
        "setNotificationPreferences",
        "pi-gui:set-notification-preferences",
        Queued,
    ),
    m(
        "setIntegratedTerminalShell",
        "pi-gui:set-integrated-terminal-shell",
        Queued,
    ),
    m(
        "setEnableTransparency",
        "pi-gui:set-enable-transparency",
        Unscoped,
    ),
    m("setThemePresetId", "pi-gui:set-theme-preset-id", Queued),
    m(
        "ensureTerminalPanel",
        "pi-gui:terminal-ensure-panel",
        Checked,
    ),
    m(
        "createTerminalSession",
        "pi-gui:terminal-create-session",
        Checked,
    ),
    m(
        "setActiveTerminalSession",
        "pi-gui:terminal-set-active-session",
        Checked,
    ),
    m("writeTerminal", "pi-gui:terminal-write", Checked),
    m("resizeTerminal", "pi-gui:terminal-resize", Checked),
    m(
        "restartTerminalSession",
        "pi-gui:terminal-restart-session",
        Checked,
    ),
    m(
        "closeTerminalSession",
        "pi-gui:terminal-close-session",
        Checked,
    ),
    m("setTerminalTitle", "pi-gui:terminal-set-title", Checked),
    m("setTerminalFocused", "pi-gui:terminal-set-focused", Send),
    m("setSidePanelFocused", "pi-gui:side-panel-set-focused", Send),
    m(
        "getNotificationPermissionStatus",
        "pi-gui:get-notification-permission-status",
        Checked,
    ),
    m(
        "requestNotificationPermission",
        "pi-gui:request-notification-permission",
        Checked,
    ),
    m(
        "openSystemNotificationSettings",
        "pi-gui:open-system-notification-settings",
        Checked,
    ),
    m(
        "pickComposerAttachments",
        "pi-gui:pick-composer-attachments",
        Queued,
    ),
    m("readClipboardImage", "pi-gui:read-clipboard-image", Checked),
    m(
        "addComposerAttachments",
        "pi-gui:add-composer-attachments",
        Queued,
    ),
    m(
        "removeComposerAttachment",
        "pi-gui:remove-composer-attachment",
        Queued,
    ),
    m(
        "editQueuedComposerMessage",
        "pi-gui:edit-queued-composer-message",
        Queued,
    ),
    m(
        "cancelQueuedComposerEdit",
        "pi-gui:cancel-queued-composer-edit",
        Queued,
    ),
    m(
        "removeQueuedComposerMessage",
        "pi-gui:remove-queued-composer-message",
        Queued,
    ),
    m(
        "steerQueuedComposerMessage",
        "pi-gui:steer-queued-composer-message",
        Queued,
    ),
    m(
        "persistComposerDraft",
        "pi-gui:persist-composer-draft",
        MainFrame,
    ),
    m(
        "updateComposerDraft",
        "pi-gui:update-composer-draft",
        Queued,
    ),
    m(
        "submitComposer",
        "pi-gui:submit-composer",
        QueuedIfSenderView,
    ),
    m("getSessionTree", "pi-gui:get-session-tree", Checked),
    m(
        "navigateSessionTree",
        "pi-gui:navigate-session-tree",
        QueuedResult,
    ),
    m("listWorkspaceFiles", "pi-gui:list-workspace-files", Checked),
    m("readWorkspaceFile", "pi-gui:read-workspace-file", Checked),
    m(
        "revealWorkspaceFile",
        "pi-gui:reveal-workspace-file",
        Checked,
    ),
    m("getChangedFiles", "pi-gui:get-changed-files", Checked),
    m("getFileDiff", "pi-gui:get-file-diff", Checked),
    m("stageFile", "pi-gui:stage-file", Checked),
    m(
        "toggleWindowMaximize",
        "pi-gui:toggle-window-maximize",
        Checked,
    ),
    m("openExternal", "app:open-external", Checked),
    m("getThemeMode", "pi-gui:get-theme-mode", Checked),
    m("getResolvedTheme", "pi-gui:get-resolved-theme", Checked),
    m("setThemeMode", "pi-gui:set-theme-mode", Queued),
    m(
        "relaunchApplication",
        "pi-gui:relaunch-application",
        Checked,
    ),
    // The preload's answer to `flushPendingComposerDraft`; not on `PiDesktopApi`.
    m(
        "pendingComposerDraftFlushed",
        "pi-gui:pending-composer-draft-flushed",
        MainFrame,
    ),
];

/// Channels main pushes to renderers.
pub mod push {
    pub const STATE_CHANGED: &str = "pi-gui:state-changed";
    pub const SELECTED_TRANSCRIPT_CHANGED: &str = "pi-gui:selected-transcript-changed";
    pub const APP_COMMAND: &str = "pi-gui:app-command";
    pub const WORKSPACE_PICKED: &str = "pi-gui:workspace-picked";
    pub const CLIPBOARD_IMAGE_PASTED: &str = "pi-gui:clipboard-image-pasted";
    pub const FLUSH_PENDING_COMPOSER_DRAFT: &str = "pi-gui:flush-pending-composer-draft";
    pub const THEME_CHANGED: &str = "pi-gui:theme-changed";
    pub const WINDOW_FOCUSED: &str = "pi-gui:window-focused";
    pub const NOTIFICATION_PERMISSION_STATUS_CHANGED: &str =
        "pi-gui:notification-permission-status-changed";
    pub const TERMINAL_DATA: &str = "pi-gui:terminal-data";
    pub const TERMINAL_EXIT: &str = "pi-gui:terminal-exit";
    pub const TERMINAL_ERROR: &str = "pi-gui:terminal-error";
    pub const EXTENSION_VIEW_MESSAGE: &str = "pi-gui:extension-view-message";
    pub const EXTENSION_VIEW_CATALOG_CHANGED: &str = "pi-gui:extension-view-catalog-changed";
    pub const EXTENSION_VIEW_OPEN_FILE: &str = "pi-gui:extension-view-open-file";
}

/// The method a renderer calls by its API name.
pub fn by_api(api: &str) -> Option<&'static Method> {
    METHODS.iter().find(|method| method.api == api)
}

/// The method behind a channel.
pub fn by_channel(channel: &str) -> Option<&'static Method> {
    METHODS.iter().find(|method| method.channel == channel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn names_and_channels_are_unique() {
        let apis: HashSet<_> = METHODS.iter().map(|method| method.api).collect();
        let channels: HashSet<_> = METHODS.iter().map(|method| method.channel).collect();
        assert_eq!(apis.len(), METHODS.len());
        assert_eq!(channels.len(), METHODS.len());
    }
}
