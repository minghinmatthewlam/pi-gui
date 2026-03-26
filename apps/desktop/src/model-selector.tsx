import { useEffect, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionRecord } from "./desktop-state";
import { buildModelOptions, THINKING_OPTIONS, type ComposerModelOption } from "./composer-commands";

interface ModelSelectorProps {
  readonly runtime: RuntimeSnapshot | undefined;
  readonly session: SessionRecord;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
}

type OpenDropdown = "none" | "model" | "thinking";

export function ModelSelector({ runtime, session, onSetModel, onSetThinking }: ModelSelectorProps) {
  const [open, setOpen] = useState<OpenDropdown>("none");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isRunning = session.status === "running";

  const currentProvider = session.config?.provider;
  const currentModelId = session.config?.modelId;
  const currentThinking = session.config?.thinkingLevel;

  useEffect(() => {
    if (open === "none") return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen("none");
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen("none");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  if (!currentProvider && !currentModelId && !currentThinking) {
    return null;
  }

  const modelOptions = buildModelOptions(runtime);
  const groupedModels = groupByProvider(modelOptions);

  return (
    <span className="model-selector" ref={containerRef}>
      {currentProvider && currentModelId ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={isRunning}
            onClick={() => setOpen(open === "model" ? "none" : "model")}
          >
            {" · "}{currentProvider}:{currentModelId}
          </button>
          {open === "model" ? (
            <div className="model-selector__dropdown" onWheel={(event) => event.stopPropagation()}>
              {groupedModels.map((group) => (
                <div key={group.provider}>
                  <div className="model-selector__group-title">{group.provider}</div>
                  {group.items.map((option) => {
                    const isActive = option.providerId === currentProvider && option.modelId === currentModelId;
                    const isUnavailable = option.description.includes("unavailable");
                    return (
                      <button
                        className={`model-selector__item${isActive ? " model-selector__item--active" : ""}${isUnavailable ? " model-selector__item--unavailable" : ""}`}
                        key={`${option.providerId}:${option.modelId}`}
                        type="button"
                        disabled={isUnavailable}
                        onClick={() => {
                          if (!isUnavailable) {
                            onSetModel(option.providerId, option.modelId);
                            setOpen("none");
                          }
                        }}
                      >
                        <span className="model-selector__item-label">{option.label}</span>
                        {isActive ? <span className="model-selector__item-meta">active</span> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groupedModels.length === 0 ? (
                <div className="model-selector__group-title">No models available</div>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {currentThinking ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={isRunning}
            onClick={() => setOpen(open === "thinking" ? "none" : "thinking")}
          >
            {" · "}{currentThinking}
          </button>
          {open === "thinking" ? (
            <div className="model-selector__dropdown" onWheel={(event) => event.stopPropagation()}>
              <div className="model-selector__group-title">Thinking Level</div>
              {THINKING_OPTIONS.map((option) => {
                const isActive = option.value === currentThinking;
                return (
                  <button
                    className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onSetThinking(option.value);
                      setOpen("none");
                    }}
                  >
                    <span className="model-selector__item-label">{option.label}</span>
                    <span className="model-selector__item-meta">{option.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

interface ModelGroup {
  readonly provider: string;
  readonly items: readonly ComposerModelOption[];
}

function groupByProvider(options: readonly ComposerModelOption[]): readonly ModelGroup[] {
  const groups = new Map<string, ComposerModelOption[]>();
  for (const option of options) {
    const existing = groups.get(option.providerId);
    if (existing) {
      existing.push(option);
    } else {
      groups.set(option.providerId, [option]);
    }
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({ provider, items }));
}
