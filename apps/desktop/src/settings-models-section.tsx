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

  const enabledPatterns = runtime?.settings.enabledModelPatterns ?? [];
  const allImplicitlyEnabled = enabledPatterns.length === 0;

  const activeScopedPatterns = allImplicitlyEnabled
    ? availableModels.map((model) => `${model.providerId}/${model.modelId}`)
    : enabledPatterns;
  const activeScopedSet = new Set(activeScopedPatterns);

  const enabledAvailableModels = availableModels.filter((model) => {
    if (allImplicitlyEnabled) return true;
    return activeScopedSet.has(`${model.providerId}/${model.modelId}`);
  });

  const defaultProvider = runtime?.settings.defaultProvider;
  const defaultModelId = runtime?.settings.defaultModelId;
  const defaultIsEnabled =
    defaultProvider && defaultModelId
      ? enabledAvailableModels.some((m) => m.providerId === defaultProvider && m.modelId === defaultModelId)
      : false;

  const filteredModels = filterModels(models, modelQuery);
  const filteredScopedModels = filterModels(availableModels, scopedQuery);

  const togglePattern = (pattern: string, checked: boolean) => {
    const newPatterns = checked
      ? [...activeScopedPatterns, pattern]
      : activeScopedPatterns.filter((entry) => entry !== pattern);
    if (newPatterns.length === 0) return;
    onSetScopedModelPatterns(newPatterns);
  };

  return (
    <>
      <SettingsCard
        description="Choose the default model for new sessions in this workspace."
        icon={<ModelIcon />}
        title="Default model"
      >
        <div className="settings-stack">
          <label className="settings-field">
            <span>Enabled models</span>
            <select
              className="settings-select"
              value={
                defaultProvider && defaultModelId && defaultIsEnabled
                  ? `${defaultProvider}:${defaultModelId}`
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
              {enabledAvailableModels.map((model) => (
                <option key={`${model.providerId}:${model.modelId}`} value={`${model.providerId}:${model.modelId}`}>
                  {model.providerName} · {model.label}
                </option>
              ))}
            </select>
          </label>
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
        description="Choose which models appear in pickers throughout the app."
        icon={<SettingsIcon />}
        title="Enabled models"
      >
        <div className="settings-stack">
          <div className="settings-pill-row">
            {activeScopedPatterns.map((pattern) => (
              <span className={settingsPill(true)} key={pattern}>
                {pattern}
              </span>
            ))}
          </div>
          {allImplicitlyEnabled ? (
            <span className="settings-card__hint">All models enabled by default.</span>
          ) : null}
          {!defaultIsEnabled && defaultProvider && defaultModelId ? (
            <span className="settings-card__warning">
              Your default model ({defaultProvider}:{defaultModelId}) is not enabled. Choose a new default above.
            </span>
          ) : null}
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span>Edit enabled models</span>
              <span>{filteredScopedModels.length}</span>
            </summary>
            <div className="settings-disclosure__body">
              <input
                aria-label="Search enabled models"
                className="settings-search"
                placeholder="Search enabled models"
                value={scopedQuery}
                onChange={(event) => setScopedQuery(event.target.value)}
              />
              <div className="settings-list">
                {filteredScopedModels.map((model) => {
                  const pattern = `${model.providerId}/${model.modelId}`;
                  const enabled = activeScopedSet.has(pattern);
                  const isLast = enabled && activeScopedPatterns.length <= 1;
                  return (
                    <label className="settings-toggle settings-toggle--row" key={pattern}>
                      <input
                        checked={enabled}
                        disabled={isLast}
                        title={isLast ? "At least one model must be enabled" : undefined}
                        type="checkbox"
                        onChange={(event) => togglePattern(pattern, event.target.checked)}
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
        description="Browse the full model catalog. Enable models above to use them."
        icon={<ModelIcon />}
        title="All models"
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
                const pattern = `${model.providerId}/${model.modelId}`;
                const enabled = activeScopedSet.has(pattern);
                const isLast = enabled && activeScopedPatterns.length <= 1;
                return (
                  <div
                    className="settings-option"
                    key={`${model.providerId}:${model.modelId}`}
                  >
                    <span className="settings-option__title">{model.providerName} · {model.label}</span>
                    <span className="settings-option__meta">
                      {model.providerId}:{model.modelId}
                      {model.reasoning ? " · reasoning" : ""}
                      {model.supportsImages ? " · images" : ""}
                      {!model.available ? " · not logged in" : ""}
                    </span>
                    {model.available ? (
                      <label className="settings-toggle settings-toggle--inline">
                        <input
                          checked={enabled}
                          disabled={isLast}
                          title={isLast ? "At least one model must be enabled" : undefined}
                          type="checkbox"
                          onChange={(event) => togglePattern(pattern, event.target.checked)}
                        />
                        <span className="sr-only">Enable</span>
                      </label>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </details>
      </SettingsCard>
    </>
  );
}
