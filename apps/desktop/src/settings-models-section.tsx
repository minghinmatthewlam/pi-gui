import { useState } from "react";
import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { ModelIcon, ReasoningIcon, SettingsIcon } from "./icons";
import {
  filterModels,
  labelForThinking,
  settingsPill,
  SettingsCard,
  THINKING_LEVELS,
} from "./settings-utils";

interface SettingsModelsSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
}

export function SettingsModelsSection({
  runtime,
  onSetDefaultModel,
  onSetThinkingLevel,
  onSetScopedModelPatterns,
}: SettingsModelsSectionProps) {
  const [modelQuery, setModelQuery] = useState("");
  const [scopedQuery, setScopedQuery] = useState("");

  const models = runtime?.models ?? [];
  const providers = runtime?.providers ?? [];
  const availableModels = models.filter((m) => m.available);
  const connectedProviders = providers.filter((p) => p.hasAuth);

  const activeScopedPatterns =
    runtime && runtime.settings.enabledModelPatterns.length > 0
      ? runtime.settings.enabledModelPatterns.map((entry) => entry.pattern)
      : availableModels.map((model) => `${model.providerId}/${model.modelId}`);

  const featuredProviderIds = new Set(
    [
      runtime?.settings.defaultProvider,
      ...connectedProviders.map((p) => p.id),
      "openai-codex",
      "anthropic",
    ].filter(Boolean),
  );

  const featuredModels = (() => {
    const seen = new Set<string>();
    return availableModels.filter((model) => {
      const key = `${model.providerId}:${model.modelId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return featuredProviderIds.has(model.providerId);
    });
  })();

  const filteredModels = filterModels(availableModels, modelQuery);
  const filteredScopedModels = filterModels(availableModels, scopedQuery);

  return (
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
              value={
                runtime?.settings.defaultProvider && runtime?.settings.defaultModelId
                  ? `${runtime.settings.defaultProvider}:${runtime.settings.defaultModelId}`
                  : ""
              }
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
                  className={settingsPill(active)}
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
              className={settingsPill(runtime?.settings.defaultThinkingLevel === level)}
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
                <span className={settingsPill(true)} key={pattern}>
                  {pattern}
                </span>
              ))
            ) : (
              <span className="settings-card__empty">No scoped models selected.</span>
            )}
          </div>
          <details className="settings-disclosure">
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
        <details className="settings-disclosure">
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
  );
}
