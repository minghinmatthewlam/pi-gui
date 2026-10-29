/*
 * English copy is the source of truth and the fallback: `MessageKey` is derived
 * from this object, so `t()` accepts only these keys, and any key another catalog
 * leaves out renders this copy. Keys are dotted and flat (no nesting) so
 * `t("settings.nav.general")` stays a checked literal.
 */
import type { PluralCategory, PluralVariantKey } from "../plural";

export const en = {
  "models.enabledCount": "{enabled} of {total}",
  "models.count": "{count} models",
  "models.count_one": "{count} model",
  "models.count_other": "{count} models",
  "providers.manageKey": "Manage API key",
  "providers.replaceKey": "Replace or remove the saved API key for {name}.",
  "providers.saveKey": "Save an API key locally for {name}.",
  "providers.bridgeUnavailable": "Desktop bridge is not available.",
  "providers.invalidUrl": "Base URL must start with http:// or https://",
  "providers.selectModel": "Select at least one model.",
  "providers.requiredId": "Provider ID is required.",
  "providers.idFormat": "Use lowercase letters, digits, and dashes (max 64 chars).",
  "providers.idInUse": 'Provider ID "{trimmed}" is already in use.',
  "mcp.globalConfig": "pi's global mcp.json",
  "mcp.remove": 'Remove MCP server "{name}"? pi in the terminal stops using it too.',
  "mcp.removeHidden":
    "{question} Its hidden settings (environment variables, headers, sign-in config) are deleted too.",
  "ui.customEndpoints": "Custom endpoints",
  "ui.addOpenAICompatibleEndpointsOllamaVLLMOrYourOwnServerStoredIn":
    "Add OpenAI-compatible endpoints (Ollama, vLLM, or your own server). Stored in ~/.pi/agent/models.json.",
  "ui.noCustomEndpointsYet": "No custom endpoints yet.",
  "ui.addEndpoint": "Add endpoint",
  "ui.registerALocalOrCustomOpenAICompatibleServer":
    "Register a local or custom OpenAI-compatible server.",
  "ui.editCustomEndpoint": "Edit custom endpoint",
  "ui.addCustomEndpoint": "Add custom endpoint",
  "ui.configureAnOpenAICompatibleServerTheEndpointAndAPIKeyAreStored":
    "Configure an OpenAI-compatible server. The endpoint and API key are stored in plaintext at",
  "ui.providerID": "Provider ID",
  "ui.lowercaseLettersDigitsAndDashesCannotBeChangedLater":
    "Lowercase letters, digits, and dashes. Cannot be changed later.",
  "ui.baseURL": "Base URL",
  "ui.includeThe": "Include the ",
  "ui.suffixOllama": " suffix. Ollama: ",
  "ui.vllm": ". vLLM: ",
  "ui.vllmPassThroughOllamaLeaveBlank": "vLLM: pass through; Ollama: leave blank",
  "ui.requiredByTheStorageFormatForVLLMStartedWith":
    "Required by the storage format. For vLLM started with ",
  "ui.enterThatKeyForOllamaOrOtherServersWithoutAuthLeaveBlank":
    ", enter that key. For Ollama or other servers without auth, leave blank and a placeholder is saved.",
  "ui.detecting": "Detecting…",
  "ui.detectModels": "Detect models",
  "ui.toolCallingIsRequiredSmallerModels7BOftenDoNotEmitOpenAI":
    "Tool calling is required. Smaller models (< 7B) often do not emit OpenAI-style function calls cleanly.",
  "ui.saveChanges": "Save changes",
  "ui.clickDetectModelsOrTypeAModelIDBelowToAddOne":
    "Click “Detect models” or type a model ID below to add one manually.",
  "ui.enableValue3": "Enable {id}",
  "ui.addModelIDManually": "Add model ID manually",
  "ui.add": "Add",
  "ui.servers": "Servers",
  "ui.sharedWithPiInTheTerminalValuePlusThisProjectSPi":
    "Shared with pi in the terminal: {globalConfigPath}, plus this project's .pi/mcp.json.",
  "ui.noMCPServersYetServersComeFromValueWhichPiInThe":
    "No MCP servers yet. Servers come from {globalConfigPath}, which pi in the terminal uses too. Connection status and sign-in show in threads: type /mcp.",
  "ui.codeMode": "Code mode",
  "ui.alwaysOn": "Always on",
  "ui.letsTheModelRunScriptsThatCallToolsTurningItOnAlso":
    "Lets the model run scripts that call tools. Turning it on also applies to open threads; turning it off applies to new threads. Off, pi turns it on when an MCP server needs it.",
  "ui.codeModeAlwaysOn": "Code mode always on",
  "ui.thisProjectValue": "This project · {target}",
  "ui.enableValue4": "Enable {name}",
  "ui.addServer": "Add server",
  "ui.savedToValue": "Saved to {configPath}.",
  "ui.name": "Name",
  "ui.serverName": "Server name",
  "ui.whatItDoes": "What it does",
  "ui.optionalPiTellsTheModelAboutTheServerWithIt":
    "Optional. pi tells the model about the server with it.",
  "ui.serverDescription": "Server description",
  "ui.searchesTheTeamSDocs": "Searches the team's docs",
  "ui.type": "Type",
  "ui.serverType": "Server type",
  "ui.command": "Command",
  "ui.startedOnThisMachineForEachThread": "Started on this machine for each thread.",
  "ui.serverCommand": "Server command",
  "ui.arguments": "Arguments",
  "ui.separatedBySpacesQuoteAnArgumentThatContainsSpaces":
    "Separated by spaces; quote an argument that contains spaces.",
  "ui.serverArguments": "Server arguments",
  "ui.aStreamableHTTPServerIfItNeedsASignInTypeMcp":
    "A streamable HTTP server. If it needs a sign-in, type /mcp login in a thread.",
  "ui.serverURL": "Server URL",
  "ui.openThreadsReloadToStartItAddEnvOrHeadersInThe":
    "Open threads reload to start it. Add env or headers in the file itself.",
  "ui.defaultModel": "Default model",
  "ui.usedForNewThreads": "Used for new threads.",
  "ui.reasoning": "Reasoning",
  "ui.defaultReasoningEffortForNewThreads": "Default reasoning effort for new threads.",
  "ui.yourDefaultModelValueValueIsTurnedOffOrItsProviderIs":
    "Your default model ({defaultProvider}/{defaultModelId}) is turned off or its provider is not connected. Choose a new default.",
  "ui.enabledModels": "Enabled models",
  "ui.searchModels": "Search models",
  "ui.onlyEnabledModelsAppearInModelPickers": "Only enabled models appear in model pickers.",
  "ui.noConnectedModelsAvailableYetConnectAProviderToAddModels":
    "No connected models available yet. Connect a provider to add models.",
  "ui.noConnectedModelsMatchValue": "No connected models match “{value}”.",
  "ui.enableValue5": "Enable {pattern}",
  "ui.notConnected": "Not connected",
  "ui.connectAProvider": "Connect a provider",
  "ui.modelsFromProvidersYouHaveNotSignedInTo": "Models from providers you have not signed in to.",
  "ui.showValueModels": "Show {length} models",
  "ui.default": "Default",
  "ui.images": "Images",
  "ui.needsAttention": "Needs attention",
  "ui.yourDefaultModelUsesThisProviderButItIsNotConnected":
    "Your default model uses this provider, but it is not connected.",
  "ui.connected": "Connected",
  "ui.piPicksModelsFromConnectedProvidersFirst": "pi picks models from connected providers first.",
  "ui.noProvidersConnectedYetSignInOrAddAnAPIKeyBelow":
    "No providers connected yet. Sign in or add an API key below.",
  "ui.available": "Available",
  "ui.searchProviders": "Search providers",
  "ui.signInWithOAuthOrSaveAnAPIKeyToConnectA":
    "Sign in with OAuth or save an API key to connect a provider.",
  "ui.noProvidersMatchValue": "No providers match “{value}”.",
  "ui.everyProviderIsConnected": "Every provider is connected.",
  "ui.showValueMore2": "Show {hiddenAvailableCount} more",
  "ui.valueAPIKey": "{name} API key",
  "ui.enterAPIKey": "Enter API key",
  "ui.removeSavedKey": "Remove saved key",
  "ui.saveKey": "Save key",
  "settings.workspace.label": "Workspace",
  "windowControls.label": "Window controls",
  "windowControls.minimize": "Minimize window",
  "windowControls.maximize": "Maximize or restore window",
  "windowControls.close": "Close window",
  "secondarySurface.backToApp": "Back to app",
  "secondarySurface.sectionsLabel": "{title} sections",
  "secondarySurface.searchLabel": "Search {title}",
  "secondarySurface.searchPlaceholder": "Search",
  "secondarySurface.noMatches": "No matches for “{query}”",
  "settings.title": "Settings",
  "settings.thisWorkspace": "this workspace",
  "settings.selectWorkspace.title": "Select a workspace",
  "settings.selectWorkspace.body":
    "Providers and models are set per workspace. Choose one, or open a folder first.",
  "settings.selectWorkspaceFirst": "Select a workspace first.",
  "settings.nav.general": "General",
  "settings.nav.appearance": "Appearance",
  "settings.nav.notifications": "Notifications",
  "settings.nav.shortcuts": "Keyboard shortcuts",
  "settings.nav.providers": "Providers",
  "settings.nav.models": "Models",
  "settings.nav.mcp": "MCP servers",
  "settings.nav.customize": "Skills and extensions",
  "settings.group.app": "App",
  "settings.group.agent": "Agent",
  "settings.group.customize": "Customize",
  "settings.section.general.description": "App and runtime defaults.",
  "settings.section.appearance.description":
    "Choose light, dark or system mode and a color preset.",
  "settings.section.notifications.description": "Choose which background events alert you.",
  "settings.section.shortcuts.description": "Shortcuts available across the app.",
  "settings.section.providers.description": "Connect providers and manage auth for {workspace}.",
  "settings.section.models.description":
    "Choose the default model and which models appear in pickers.",
  "settings.section.mcp.description":
    "Add, remove and switch the MCP servers pi connects in each thread.",
  "settings.general.groupAgent": "Agent",
  "settings.general.modelScope.title": "Model settings scope",
  "settings.general.modelScope.description":
    "Apply the default model and enabled models everywhere, or set them per repo.",
  "settings.general.modelScope.label": "Model settings scope",
  "settings.general.modelScope.appGlobal": "App global",
  "settings.general.modelScope.perRepo": "Per repo",
  "settings.general.skillCommands.title": "Skill slash commands",
  "settings.general.skillCommands.description":
    "Offer each skill as a slash command in the composer.",
  "settings.general.skillCommands.label": "Enable skill slash commands",
  "settings.general.groupTerminal": "Terminal",
  "settings.general.shell.title": "Shell",
  "settings.general.shell.description":
    "The shell the integrated terminal starts. Leave blank to use your login shell.",
  "settings.general.shell.label": "Shell of integrated terminal",
  "settings.appearance.groupTheme": "Theme",
  "settings.appearance.themeLabel": "Theme",
  "settings.appearance.mode.system": "System",
  "settings.appearance.mode.light": "Light",
  "settings.appearance.mode.dark": "Dark",
  "settings.appearance.language.title": "Language",
  "settings.appearance.language.description":
    "Follow the system language, or pick the language pi-gui shows.",
  "settings.appearance.language.label": "Language",
  "settings.appearance.language.system": "Follow system",
  "settings.appearance.colorPreset.title": "Color preset",
  "settings.appearance.colorPreset.label": "Color preset",
  "settings.appearance.transparency.title": "Window transparency",
  "settings.appearance.transparency.description":
    "Let desktop colors show through supported surfaces.",
  "settings.appearance.transparency.label": "Window transparency",
  "settings.appearance.preset.default": "The pi-gui palette.",
  "settings.appearance.preset.catppuccin": "Soft pastel Latte and Mocha variants.",
  "settings.appearance.preset.tokyo-night": "A cool editor palette with a bright Day variant.",
  "settings.appearance.preset.nord": "Low-contrast arctic neutrals and blue accents.",
  "settings.appearance.preset.dracula": "Dracula and its official Alucard light variant.",
  "settings.appearance.preset.gruvbox": "Warm retro contrast.",
  "settings.appearance.preset.github": "GitHub-style light and dark surfaces.",
  "settings.appearance.preset.vscode": "Familiar editor colours with blue accents.",
  "settings.notifications.groupSystem": "System",
  "settings.notifications.groupSystem.description":
    "macOS decides whether pi-gui can show desktop notifications at all.",
  "settings.notifications.access.title": "macOS notification access",
  "settings.notifications.access.enabled": "Enabled",
  "settings.notifications.access.turnedOff": "Turned off",
  "settings.notifications.access.notEnabled": "Not enabled yet",
  "settings.notifications.access.unavailable": "Unavailable",
  "settings.notifications.access.checking": "Checking…",
  "settings.notifications.access.descriptionGranted":
    "macOS will allow pi-gui to show desktop notifications for background thread updates.",
  "settings.notifications.access.descriptionDenied":
    "macOS notifications are turned off for pi-gui. Enable them in System Settings to receive background completion alerts.",
  "settings.notifications.access.descriptionDefault":
    "pi-gui has not asked macOS for desktop notification access yet.",
  "settings.notifications.access.descriptionUnsupported":
    "Desktop notifications are unavailable on this system.",
  "settings.notifications.access.descriptionChecking":
    "Checking whether macOS notifications are available for pi-gui.",
  "settings.notifications.turnOn.title": "Turn on notifications",
  "settings.notifications.turnOn.descriptionAsk":
    "pi-gui asks macOS when active work first moves into the background. You can also ask now.",
  "settings.notifications.turnOn.descriptionOpen":
    "macOS notifications are already turned off for pi-gui. Open System Settings to enable them again.",
  "settings.notifications.turnOn.ask": "Ask macOS",
  "settings.notifications.turnOn.openSettings": "Open System Settings",
  "settings.notifications.groupInApp": "In-app alerts",
  "settings.notifications.groupInApp.description":
    "Choose which background events should try to notify once macOS access is enabled.",
  "settings.notifications.completion.title": "Background completion",
  "settings.notifications.completion.description": "Notify when a background session finishes.",
  "settings.notifications.failures.title": "Background failures",
  "settings.notifications.failures.description": "Notify when a background session fails.",
  "settings.notifications.attention.title": "Needs input or approval",
  "settings.notifications.attention.description": "Notify when input is needed to continue.",
  "settings.shortcuts.groupApp": "App",
  "settings.shortcuts.groupThreads": "Threads",
  "settings.shortcuts.groupComposer": "Composer",
  "settings.shortcuts.groupWorkbench": "Workbench",
  "settings.shortcuts.commandPalette": "Command palette",
  "settings.shortcuts.goToFile": "Go to file",
  "settings.shortcuts.openSettings": "Open settings",
  "settings.shortcuts.toggleSidebar": "Toggle sidebar",
  "settings.shortcuts.toggleSidePanel": "Toggle side panel",
  "settings.shortcuts.newWindow": "New window",
  "settings.shortcuts.newThread": "New thread",
  "settings.shortcuts.switchRecent": "Switch to recent thread",
  "settings.shortcuts.cycleThreads": "Cycle through threads",
  "settings.shortcuts.findInThread": "Find in thread",
  "settings.shortcuts.send": "Send message, or queue it during a run",
  "settings.shortcuts.steer": "Steer the running agent",
  "settings.shortcuts.newLine": "New line",
  "settings.shortcuts.toggleTerminal": "Toggle terminal",
  "settings.shortcuts.newTerminalTab": "New terminal tab",
  "settings.shortcuts.toggleReview": "Toggle review",
  "settings.shortcuts.switchSidePanelTab": "Switch to side panel tab",
  "settings.shortcuts.closeWorkbenchTab": "Close workbench tab",
  "settings.controls.choose": "Choose…",
  "settings.thinking.off": "Off",
  "settings.thinking.minimal": "Minimal",
  "settings.thinking.low": "Low",
  "settings.thinking.medium": "Medium",
  "settings.thinking.high": "High",
  "settings.thinking.xhigh": "Extra High",
  "settings.thinking.max": "Max",
  "settings.provider.status.oauth": "OAuth · connected",
  "settings.provider.status.authFile": "API key · connected",
  "settings.provider.status.env": "Environment variable · connected",
  "settings.provider.status.externalConnected": "Configured externally · connected",
  "settings.provider.status.configureExternally": "Configure externally",
  "settings.provider.status.oauthOrApiKey": "OAuth or API key",
  "settings.provider.status.oauthOnly": "OAuth",
  "settings.provider.status.apiKey": "API key",
  "settings.provider.status.builtIn": "Built in",
  "settings.provider.action.logout": "Logout",
  "settings.provider.action.login": "Login",
  "settings.provider.action.manage": "Manage",
  "settings.provider.action.setApiKey": "Set API key",
  "settings.common.remove": "Remove",
  "settings.common.edit": "Edit",
  "settings.common.cancel": "Cancel",
} as const;

export type MessageKey = keyof typeof en;

/** The plain messages, without plural variants. */
export type RequiredMessageKey = Exclude<MessageKey, PluralVariantKey>;

/** Keys English gives plural forms to, e.g. `models.count` for `models.count_one`. */
type PluralBaseKey = MessageKey extends infer Key
  ? Key extends `${infer Base}_${PluralCategory}`
    ? Base
    : never
  : never;

/**
 * A plural form of one of those keys in any CLDR category, so a language with
 * `few` or `many` (Russian, Polish, Arabic) can add forms English does not have.
 */
export type PluralFormKey = `${PluralBaseKey}_${PluralCategory}`;

/**
 * Every plain key, values widened to `string`. Plural variants (`key_one`,
 * `key_few`, …) are optional because a language only defines the categories its
 * grammar has; `translate.ts` reuses the plain key for the ones it leaves out.
 * Other locales are typed `Partial<Messages>` and fall back to English.
 */
export type Messages = Record<RequiredMessageKey, string> &
  Partial<Record<MessageKey | PluralFormKey, string>>;
