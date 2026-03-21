import { useMemo, useState, type ReactNode } from "react";
import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";
import type { NotificationPreferences, WorkspaceRecord } from "./desktop-state";
import { ModelIcon, ReasoningIcon, RefreshIcon, SettingsIcon, SkillIcon, StatusIcon } from "./icons";

export type SettingsSection = "general" | "providers" | "models" | "notifications";

interface SettingsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly section: SettingsSection;
  readonly notificationPreferences: NotificationPreferences;
  readonly onRefresh: () => void;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
}

const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export function SettingsView({
  workspace,
  runtime,
  section,
  notificationPreferences,
  onRefresh,
  onSetDefaultModel,
  onSetThinkingLevel,
  onToggleSkillCommands,
  onSetScopedModelPatterns,
  onLoginProvider,
  onLogoutProvider,
  onSetNotificationPreferences,
}: SettingsViewProps) {
  const models = runtime?.models ?? [];
  const providers = runtime?.providers ?? [];
  const connectedProviders = providers.filter((provider) => provider.hasAuth);
  const oauthProviders = providers.filter((provider) => provider.oauthSupported);
  const availableModels = models.filter((model) => model.available);
  const [providerQuery, setProviderQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [scopedQuery, setScopedQuery] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [showScopedInventory, setShowScopedInventory] = useState(false);

  const activeScopedPatterns = useMemo(() => {
    if (!runtime) {
      return [];
    }
    return runtime.settings.enabledModelPatterns.length > 0
      ? runtime.settings.enabledModelPatterns.map((entry) => entry.pattern)
      : availableModels.map((model) => `${model.providerId}/${model.modelId}`);
  }, [availableModels, runtime]);

  const featuredProviderIds = useMemo(
    () =>
      new Set(
        [
          runtime?.settings.defaultProvider,
          ...connectedProviders.map((provider) => provider.id),
          "openai-codex",
          "anthropic",
        ].filter(Boolean),
      ),
    [connectedProviders, runtime?.settings.defaultProvider],
  );

  const featuredModels = useMemo(() => {
    const seen = new Set<string>();
    return availableModels.filter((model) => {
      const key = `${model.providerId}:${model.modelId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return featuredProviderIds.has(model.providerId);
    });
  }, [availableModels, featuredProviderIds]);

  const filteredProviders = useMemo(
    () => filterProviders(providers, providerQuery),
    [providerQuery, providers],
  );
  const filteredModels = useMemo(
    () => filterModels(availableModels, modelQuery),
    [availableModels, modelQuery],
  );
  const filteredScopedModels = useMemo(
    () => filterModels(availableModels, scopedQuery),
    [availableModels, scopedQuery],
  );

  if (!workspace && section !== "general" && section !== "notifications") {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">Settings</div>
          <h1>Select a workspace</h1>
          <p>Model, auth, and skill settings are scoped to the selected workspace.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation settings-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">Settings</div>
            <h1 className="view-header__title">{sectionTitle(section)}</h1>
            <p className="view-header__body">
              {sectionDescription(section, workspace?.name ?? "this workspace")}
            </p>
          </div>
          <button className="button button--secondary" type="button" onClick={onRefresh}>
            <RefreshIcon />
            <span>Refresh</span>
          </button>
        </header>

        <div className="settings-grid">
          {section === "general" ? (
            <>
              <SettingsCard
                description="Current workspace defaults and runtime snapshot."
                icon={<SettingsIcon />}
                title="General"
              >
                <div className="settings-list">
                  <SettingsInfoRow label="Workspace" value={workspace?.name ?? "No workspace selected"} />
                  <SettingsInfoRow
                    label="Default model"
                    value={
                      runtime?.settings.defaultProvider && runtime?.settings.defaultModelId
                        ? `${runtime.settings.defaultProvider}:${runtime.settings.defaultModelId}`
                        : "Not set"
                    }
                  />
                  <SettingsInfoRow
                    label="Reasoning"
                    value={labelForThinking(runtime?.settings.defaultThinkingLevel ?? "medium")}
                  />
                  <SettingsInfoRow
                    label="Connected providers"
                    value={connectedProviders.length > 0 ? String(connectedProviders.length) : "None"}
                  />
                  <SettingsInfoRow label="Discovered skills" value={String(runtime?.skills.length ?? 0)} />
                </div>
              </SettingsCard>
              <SettingsCard
                description="Keep the highest-value controls discoverable without sending people through runtime-specific menus."
                icon={<SettingsIcon />}
                title="Shortcuts"
              >
                <div className="settings-list">
                  <SettingsInfoRow label="Open settings" value="Cmd+," />
                  <SettingsInfoRow label="Send message" value="Enter" />
                  <SettingsInfoRow label="New line" value="Shift+Enter" />
                </div>
              </SettingsCard>
              <SettingsCard
                description="Keep skill slash commands available in the composer while the full Skills surface stays separate."
                icon={<SkillIcon />}
                title="Skill commands"
              >
                <label className="settings-toggle">
                  <input
                    checked={runtime?.settings.enableSkillCommands ?? true}
                    type="checkbox"
                    onChange={(event) => onToggleSkillCommands(event.target.checked)}
                  />
                  <span>Enable skill slash commands</span>
                </label>
              </SettingsCard>
            </>
          ) : null}

          {section === "providers" ? (
            <>
              <SettingsCard
                description="Connected providers are used first for picking models and auth-aware slash commands."
                icon={<StatusIcon />}
                title="Connected"
              >
                <div className="settings-list">
                  {connectedProviders.length > 0 ? (
                    connectedProviders.map((provider) => (
                      <ProviderRow
                        key={provider.id}
                        provider={provider}
                        onLoginProvider={onLoginProvider}
                        onLogoutProvider={onLogoutProvider}
                      />
                    ))
                  ) : (
                    <div className="settings-card__empty">No providers connected yet.</div>
                  )}
                </div>
              </SettingsCard>

              <SettingsCard
                description="OAuth-capable providers can sign in directly from the desktop app."
                icon={<StatusIcon />}
                title="Sign in"
              >
                <div className="settings-list">
                  {oauthProviders.map((provider) => (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      onLoginProvider={onLoginProvider}
                      onLogoutProvider={onLogoutProvider}
                    />
                  ))}
                </div>
              </SettingsCard>

              <SettingsCard
                description="The full provider inventory stays searchable here without dominating the default settings view."
                icon={<SettingsIcon />}
                title="All providers"
              >
                <details className="settings-disclosure" open={showAllProviders} onToggle={(event) => setShowAllProviders(event.currentTarget.open)}>
                  <summary className="settings-disclosure__summary">
                    <span>Browse all providers</span>
                    <span>{filteredProviders.length}</span>
                  </summary>
                  <div className="settings-disclosure__body">
                    <input
                      aria-label="Search providers"
                      className="settings-search"
                      placeholder="Search providers"
                      value={providerQuery}
                      onChange={(event) => setProviderQuery(event.target.value)}
                    />
                    <div className="settings-list">
                      {filteredProviders.map((provider) => (
                        <ProviderRow
                          key={provider.id}
                          provider={provider}
                          onLoginProvider={onLoginProvider}
                          onLogoutProvider={onLogoutProvider}
                        />
                      ))}
                    </div>
                  </div>
                </details>
              </SettingsCard>
            </>
          ) : null}

          {section === "models" ? (
            <>
              <SettingsCard
                description="Choose the default model for new sessions in this workspace."
                icon={<ModelIcon />}
                title="Default model"
              >
                <div className="settings-stack">
                  <label className="settings-field">
                    <span>Featured models</span>
                    <select
                      className="settings-select"
                      value={runtime?.settings.defaultProvider && runtime?.settings.defaultModelId ? `${runtime.settings.defaultProvider}:${runtime.settings.defaultModelId}` : ""}
                      onChange={(event) => {
                        const [provider, ...modelParts] = event.target.value.split(":");
                        const modelId = modelParts.join(":");
                        if (provider && modelId) {
                          onSetDefaultModel(provider, modelId);
                        }
                      }}
                    >
                      <option value="">Choose a model</option>
                      {featuredModels.map((model) => (
                        <option key={`${model.providerId}:${model.modelId}`} value={`${model.providerId}:${model.modelId}`}>
                          {model.providerName} · {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="settings-pill-row">
                    {featuredModels.map((model) => {
                      const active =
                        runtime?.settings.defaultProvider === model.providerId &&
                        runtime?.settings.defaultModelId === model.modelId;
                      return (
                        <button
                          className={`settings-pill ${active ? "settings-pill--active" : ""}`}
                          key={`${model.providerId}:${model.modelId}`}
                          type="button"
                          onClick={() => onSetDefaultModel(model.providerId, model.modelId)}
                        >
                          {model.providerName} · {model.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </SettingsCard>

              <SettingsCard
                description="Set the workspace default reasoning level."
                icon={<ReasoningIcon />}
                title="Reasoning"
              >
                <div className="settings-pill-row">
                  {THINKING_LEVELS.map((level) => (
                    <button
                      className={`settings-pill ${runtime?.settings.defaultThinkingLevel === level ? "settings-pill--active" : ""}`}
                      key={level}
                      type="button"
                      onClick={() => onSetThinkingLevel(level)}
                    >
                      {labelForThinking(level)}
                    </button>
                  ))}
                </div>
              </SettingsCard>

              <SettingsCard
                description="Manage the shortlist used for quick model switching."
                icon={<SettingsIcon />}
                title="Scoped models"
              >
                <div className="settings-stack">
                  <div className="settings-pill-row">
                    {activeScopedPatterns.length > 0 ? (
                      activeScopedPatterns.map((pattern) => (
                        <span className="settings-pill settings-pill--active" key={pattern}>
                          {pattern}
                        </span>
                      ))
                    ) : (
                      <span className="settings-card__empty">No scoped models selected.</span>
                    )}
                  </div>
                  <details
                    className="settings-disclosure"
                    open={showScopedInventory}
                    onToggle={(event) => setShowScopedInventory(event.currentTarget.open)}
                  >
                    <summary className="settings-disclosure__summary">
                      <span>Edit shortlist</span>
                      <span>{filteredScopedModels.length}</span>
                    </summary>
                    <div className="settings-disclosure__body">
                      <input
                        aria-label="Search scoped models"
                        className="settings-search"
                        placeholder="Search scoped models"
                        value={scopedQuery}
                        onChange={(event) => setScopedQuery(event.target.value)}
                      />
                      <div className="settings-list">
                        {filteredScopedModels.map((model) => {
                          const pattern = `${model.providerId}/${model.modelId}`;
                          const enabled = activeScopedPatterns.includes(pattern);
                          return (
                            <label className="settings-toggle settings-toggle--row" key={pattern}>
                              <input
                                checked={enabled}
                                type="checkbox"
                                onChange={(event) =>
                                  onSetScopedModelPatterns(
                                    event.target.checked
                                      ? [...activeScopedPatterns, pattern]
                                      : activeScopedPatterns.filter((entry) => entry !== pattern),
                                  )
                                }
                              />
                              <span>
                                <strong>{model.providerName}</strong> · {model.label}
                                <span className="settings-list__meta"> · {pattern}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </details>
                </div>
              </SettingsCard>

              <SettingsCard
                description="Search the full available model inventory without forcing every model into the main controls."
                icon={<ModelIcon />}
                title="All available models"
              >
                <details className="settings-disclosure" open={showAllModels} onToggle={(event) => setShowAllModels(event.currentTarget.open)}>
                  <summary className="settings-disclosure__summary">
                    <span>Browse full model inventory</span>
                    <span>{filteredModels.length}</span>
                  </summary>
                  <div className="settings-disclosure__body">
                    <input
                      aria-label="Search models"
                      className="settings-search"
                      placeholder="Search models"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                    />
                    <div className="settings-list">
                      {filteredModels.map((model) => {
                        const active =
                          runtime?.settings.defaultProvider === model.providerId &&
                          runtime?.settings.defaultModelId === model.modelId;
                        return (
                          <button
                            className={`settings-option ${active ? "settings-option--active" : ""}`}
                            key={`${model.providerId}:${model.modelId}`}
                            type="button"
                            onClick={() => onSetDefaultModel(model.providerId, model.modelId)}
                          >
                            <span className="settings-option__title">{model.providerName} · {model.label}</span>
                            <span className="settings-option__meta">
                              {model.providerId}:{model.modelId}
                              {model.reasoning ? " · reasoning" : ""}
                              {model.supportsImages ? " · images" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </details>
              </SettingsCard>
            </>
          ) : null}

          {section === "notifications" ? (
            <SettingsCard
              description="Control which background events trigger desktop notifications."
              icon={<StatusIcon />}
              title="Notifications"
            >
              <div className="settings-toggle-list">
                <label className="settings-toggle">
                  <input
                    checked={notificationPreferences.backgroundCompletion}
                    type="checkbox"
                    onChange={(event) => onSetNotificationPreferences({ backgroundCompletion: event.target.checked })}
                  />
                  <span>Background completion</span>
                </label>
                <label className="settings-toggle">
                  <input
                    checked={notificationPreferences.backgroundFailure}
                    type="checkbox"
                    onChange={(event) => onSetNotificationPreferences({ backgroundFailure: event.target.checked })}
                  />
                  <span>Background failures</span>
                </label>
                <label className="settings-toggle">
                  <input
                    checked={notificationPreferences.attentionNeeded}
                    type="checkbox"
                    onChange={(event) => onSetNotificationPreferences({ attentionNeeded: event.target.checked })}
                  />
                  <span>Needs input or approval</span>
                </label>
              </div>
            </SettingsCard>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SettingsCard({
  title,
  description,
  icon,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card__header">
        <span className="settings-card__icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function SettingsInfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="settings-list__row">
      <div className="settings-list__body">
        <div className="settings-list__title">{label}</div>
        <div className="settings-list__meta">{value}</div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  onLoginProvider,
  onLogoutProvider,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
}) {
  return (
    <div className="settings-list__row">
      <div className="settings-list__body">
        <div className="settings-list__title">{provider.name}</div>
        <div className="settings-list__meta">
          {provider.oauthSupported ? "OAuth" : provider.authType === "api_key" ? "API key" : "Built in"}
          {provider.hasAuth ? " · connected" : ""}
        </div>
      </div>
      <button
        className="button button--secondary"
        type="button"
        onClick={() => (provider.hasAuth ? onLogoutProvider(provider.id) : onLoginProvider(provider.id))}
      >
        {provider.hasAuth ? "Logout" : provider.oauthSupported ? "Login" : "Configure externally"}
      </button>
    </div>
  );
}

function sectionTitle(section: SettingsSection): string {
  switch (section) {
    case "providers":
      return "Providers";
    case "models":
      return "Models";
    case "notifications":
      return "Notifications";
    default:
      return "General";
  }
}

function sectionDescription(section: SettingsSection, workspaceName: string): string {
  switch (section) {
    case "providers":
      return `Connect providers and manage auth for ${workspaceName}.`;
    case "models":
      return `Choose defaults and quick-switch models for ${workspaceName}.`;
    case "notifications":
      return "Only background sessions should notify by default.";
    default:
      return "Keep the high-value app and runtime controls close to hand.";
  }
}

function labelForThinking(level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>): string {
  if (level === "xhigh") {
    return "Extra High";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function filterProviders(
  providers: readonly RuntimeSnapshot["providers"][number][],
  query: string,
): readonly RuntimeSnapshot["providers"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return providers;
  }

  return providers.filter((provider) =>
    [provider.id, provider.name, provider.authType].some((value) => value.toLowerCase().includes(normalized)),
  );
}

function filterModels(
  models: readonly RuntimeSnapshot["models"][number][],
  query: string,
): readonly RuntimeSnapshot["models"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }

  return models.filter((model) =>
    [model.providerId, model.providerName, model.modelId, model.label].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}
