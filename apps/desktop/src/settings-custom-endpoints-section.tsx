import { useCallback, useEffect, useMemo, useState } from "react";
import { CUSTOM_PROVIDER_ID_PATTERN, isValidHttpBaseUrl } from "@pi-gui/pi-sdk-driver/custom-provider-types";
import type { CustomProviderConfig, CustomProviderModelConfig } from "./ipc";
import { SettingsGroup } from "./settings-utils";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode = { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderConfig };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  const [entries, setEntries] = useState<readonly CustomProviderConfig[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .listCustomProviders()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleSave = useCallback(
    async (config: CustomProviderConfig): Promise<string | undefined> => {
      const error = await onSaveCustomProvider(config);
      if (!error) {
        reload();
      }
      return error;
    },
    [onSaveCustomProvider, reload],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const error = await onDeleteCustomProvider(providerId);
      if (error) {
        setLoadError(error);
        return;
      }
      reload();
    },
    [onDeleteCustomProvider, reload],
  );

  return (
    <>
      <SettingsGroup
        title="Custom endpoints"
        description="Add OpenAI-compatible endpoints (Ollama, vLLM, or your own server). Stored in ~/.pi/agent/models.json."
      >
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">No custom endpoints yet.</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {entry.baseUrl} · {entry.models.length} model{entry.models.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  Edit
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleDelete(entry.providerId)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">Add endpoint</div>
            <div className="settings-row__description">
              Register a local or custom OpenAI-compatible server.
            </div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              Add endpoint
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind !== "closed" ? (
        <CustomEndpointDialog
          mode={dialog}
          existingProviderIds={existingProviderIds}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

interface CustomEndpointDialogProps {
  readonly mode: Exclude<DialogMode, { kind: "closed" }>;
  readonly existingProviderIds: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (config: CustomProviderConfig) => Promise<string | undefined>;
}

function CustomEndpointDialog({ mode, existingProviderIds, onClose, onSave }: CustomEndpointDialogProps) {
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...initial.models] : [],
  );
  const [probeCandidates, setProbeCandidates] = useState<readonly string[]>([]);
  const [probeError, setProbeError] = useState<string | undefined>();
  const [probePending, setProbePending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [savePending, setSavePending] = useState(false);

  const selectedModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const isEdit = mode.kind === "edit";

  const idValidationError = useMemo(() => validateProviderId(providerId, existingProviderIds, initial?.providerId), [
    providerId,
    existingProviderIds,
    initial?.providerId,
  ]);

  const handleProbe = async () => {
    const api = window.piApp;
    if (!api) {
      setProbeError("Desktop bridge is not available.");
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setProbeError("Base URL must start with http:// or https://");
      return;
    }
    setProbePending(true);
    setProbeError(undefined);
    const result = await api.probeCustomProviderModels({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
    });
    setProbePending(false);
    if (!result.ok) {
      setProbeError(result.error);
      setProbeCandidates([]);
      return;
    }
    setProbeCandidates(result.models);
  };

  const toggleModel = (id: string, contextWindow?: number) => {
    setModels((current) => {
      const existing = current.find((model) => model.id === id);
      if (existing) {
        return current.filter((model) => model.id !== id);
      }
      return [...current, contextWindow !== undefined ? { id, contextWindow } : { id }];
    });
  };

  const handleManualAdd = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    if (selectedModelIds.has(trimmed)) {
      return;
    }
    setModels((current) => [...current, { id: trimmed }]);
  };

  const handleSave = async () => {
    if (idValidationError) {
      setFormError(idValidationError);
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setFormError("Base URL must start with http:// or https://");
      return;
    }
    if (models.length === 0) {
      setFormError("Select at least one model.");
      return;
    }
    setSavePending(true);
    setFormError(undefined);
    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models,
    });
    if (error) {
      setSavePending(false);
      setFormError(error);
      return;
    }
    onClose();
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        className="extension-dialog"
        data-testid="custom-endpoint-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savePending) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="extension-dialog__title">{isEdit ? "Edit custom endpoint" : "Add custom endpoint"}</div>
        <p className="extension-dialog__body">
          Configure an OpenAI-compatible server. The endpoint and API key are stored in plaintext at
          <code> ~/.pi/agent/models.json</code>.
        </p>
        <label className="settings-field">
          <span>Provider ID</span>
          <input
            aria-label="Provider ID"
            autoFocus={!isEdit}
            className="settings-search"
            disabled={isEdit || savePending}
            placeholder="ollama-local"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value.trim().toLowerCase())}
          />
          {idValidationError ? (
            <span className="settings-row__description settings-warning">{idValidationError}</span>
          ) : (
            <span className="settings-row__description">
              Lowercase letters, digits, and dashes. Cannot be changed later.
            </span>
          )}
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            aria-label="Base URL"
            className="settings-search"
            disabled={savePending}
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <span className="settings-row__description">
            Include the <code>/v1</code> suffix. Ollama: <code>http://localhost:11434/v1</code>. vLLM:{" "}
            <code>http://localhost:8000/v1</code>.
          </span>
        </label>
        <label className="settings-field">
          <span>API key</span>
          <input
            aria-label="API key"
            className="settings-search"
            disabled={savePending}
            placeholder="vLLM: pass through; Ollama: leave blank"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="settings-row__description">
            Required by the storage format. For vLLM started with <code>--api-key</code>, enter that key. For Ollama
            or other servers without auth, leave blank and a placeholder is saved.
          </span>
        </label>

        <div className="settings-field">
          <div className="settings-field__header">
            <span>Models</span>
            <button
              className="button button--secondary"
              disabled={probePending || savePending}
              type="button"
              onClick={() => void handleProbe()}
            >
              {probePending ? "Detecting…" : "Detect models"}
            </button>
          </div>
          {probeError ? (
            <p className="settings-row__description settings-warning">{probeError}</p>
          ) : null}
          <ModelChecklist
            probed={probeCandidates}
            selected={models}
            onToggle={toggleModel}
            onManualAdd={handleManualAdd}
            disabled={savePending}
          />
          <p className="settings-row__description">
            Tool calling is required. Smaller models (&lt; 7B) often do not emit OpenAI-style function calls cleanly.
          </p>
        </div>

        {formError ? <p className="extension-dialog__body settings-warning">{formError}</p> : null}
        <div className="extension-dialog__actions">
          <button className="button button--secondary" disabled={savePending} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button"
            disabled={savePending || Boolean(idValidationError) || models.length === 0 || !baseUrl.trim()}
            type="button"
            onClick={() => void handleSave()}
          >
            {isEdit ? "Save changes" : "Add endpoint"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ModelChecklistProps {
  readonly probed: readonly string[];
  readonly selected: readonly CustomProviderModelConfig[];
  readonly onToggle: (id: string, contextWindow?: number) => void;
  readonly onManualAdd: (id: string) => void;
  readonly disabled: boolean;
}

function ModelChecklist({ probed, selected, onToggle, onManualAdd, disabled }: ModelChecklistProps) {
  const [manualDraft, setManualDraft] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((model) => model.id)), [selected]);
  const knownIds = useMemo(() => new Set([...probed, ...selected.map((model) => model.id)]), [probed, selected]);

  const submitManual = () => {
    onManualAdd(manualDraft);
    setManualDraft("");
  };

  return (
    <div className="settings-disclosure__body">
      {knownIds.size === 0 ? (
        <p className="settings-row__description">
          Click &ldquo;Detect models&rdquo; or type a model ID below to add one manually.
        </p>
      ) : (
        <ul className="settings-list">
          {[...knownIds].sort((a, b) => a.localeCompare(b)).map((id) => (
            <li key={id} className="settings-row">
              <label className="settings-row__label">
                <input
                  aria-label={`Enable ${id}`}
                  type="checkbox"
                  checked={selectedIds.has(id)}
                  disabled={disabled}
                  onChange={() => onToggle(id)}
                />
                <span className="settings-row__title">{id}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-row">
        <input
          aria-label="Add model ID manually"
          className="settings-search"
          disabled={disabled}
          placeholder="Add model ID manually"
          value={manualDraft}
          onChange={(event) => setManualDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitManual();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={disabled || manualDraft.trim().length === 0}
          type="button"
          onClick={submitManual}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function validateProviderId(
  candidate: string,
  existing: readonly string[],
  editing?: string,
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return "Provider ID is required.";
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return "Use lowercase letters, digits, and dashes (max 64 chars).";
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return `Provider ID "${trimmed}" is already in use.`;
  }
  return undefined;
}
