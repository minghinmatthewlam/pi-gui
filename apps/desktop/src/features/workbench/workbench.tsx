import { useTranslation, translate, type Translate } from "../../i18n";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  formatShortcut,
  getSidePanelTabShortcutLabel,
  SIDE_PANEL_TAB_SHORTCUT_SLOT_COUNT,
} from "../../../contracts/ipc";
import { toolRefId, type TaskWorkbenchTemplate, type ToolRef } from "../../../contracts/workbench";
import type { DesktopExtensionViewInfo } from "../../../contracts/extension-views";
import { CloseIcon, ExtensionIcon, PlusIcon, SidePanelIcon } from "../../ui/icons";
import { builtinToolEntries, builtinTools, BUILTIN_TOOLS } from "./builtin-tools";
import { WorkbenchResizeHandle } from "./workbench-resize-handle";
import { activeWorkbenchTool } from "./workbench-state";

interface WorkbenchProps {
  readonly view: TaskWorkbenchTemplate;
  readonly platform: NodeJS.Platform;
  /** Whether the side panel tab modifier is held, so tabs show their numbers. */
  readonly tabHintsVisible: boolean;
  readonly onResize: (width: number) => void;
  readonly onTogglePanel: () => void;
  readonly onOpenTool: (tool: ToolRef) => void;
  readonly onActivateTool: (toolId: string) => void;
  readonly onCloseTool: (toolId: string) => void;
  readonly onShowChooser: () => void;
  readonly children?: ReactNode;
  readonly error?: string;
  readonly loading?: boolean;
  readonly onRetryRestore?: () => void;
  readonly extensionViews?: readonly DesktopExtensionViewInfo[];
  readonly extensionViewsLoading?: boolean;
  readonly extensionViewsError?: string;
  readonly onReloadExtensionViews?: () => void;
}

export function workbenchToolLabel(tool: ToolRef, t: Translate = translate): string {
  return tool.kind === "extension" ? tool.viewId : builtinTools(t)[tool.kind].label;
}

function ToolIcon({ tool }: { readonly tool: ToolRef }) {
  if (tool.kind === "extension") return <ExtensionIcon />;
  const { Icon } = BUILTIN_TOOLS[tool.kind];
  return <Icon />;
}

export function Workbench({
  view,
  platform,
  tabHintsVisible,
  onResize,
  onTogglePanel,
  onOpenTool,
  onActivateTool,
  onCloseTool,
  onShowChooser,
  children,
  error,
  loading = false,
  onRetryRestore,
  extensionViews = [],
  extensionViewsLoading = false,
  extensionViewsError = "",
  onReloadExtensionViews,
}: WorkbenchProps) {
  const { t } = useTranslation();

  const panelId = useId();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeTool = activeWorkbenchTool(view);
  const activeExtension =
    activeTool?.kind === "extension"
      ? extensionViews.find(
          (entry) => entry.extensionId === activeTool.extensionId && entry.id === activeTool.viewId,
        )
      : undefined;
  useEffect(() => {
    if (view.visibility === "visible" && view.selection.kind === "tool") {
      tabRefs.current
        .get(view.selection.toolId)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [view.selection, view.visibility]);

  const tabId = (toolId: string) => `${panelId}-${encodeURIComponent(toolId)}`;

  const closeAndFocus = (toolId: string) => {
    const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
    const remaining = view.tools.filter((tool) => toolRefId(tool) !== toolId);
    const neighbor = remaining[Math.min(index, remaining.length - 1)];
    const active = view.selection;
    const nextId =
      active.kind === "tool" && active.toolId !== toolId
        ? active.toolId
        : neighbor
          ? toolRefId(neighbor)
          : undefined;
    onCloseTool(toolId);
    window.requestAnimationFrame(() => {
      if (nextId) tabRefs.current.get(nextId)?.focus();
      else addRef.current?.focus();
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, toolId: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      closeAndFocus(toolId);
      return;
    }
    const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % view.tools.length
        : event.key === "ArrowLeft"
          ? (index - 1 + view.tools.length) % view.tools.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? view.tools.length - 1
              : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTool = view.tools[nextIndex];
    if (!nextTool) return;
    const nextId = toolRefId(nextTool);
    onActivateTool(nextId);
    tabRefs.current.get(nextId)?.focus();
  };

  if (view.visibility === "hidden") return null;

  return (
    <aside
      aria-label={t("ui.sideWorkspace")}
      className="workbench side-panel"
      data-testid="workbench"
      id="task-workbench"
    >
      <WorkbenchResizeHandle onResize={onResize} />
      <div className="workbench__tabbar">
        <div aria-label={t("ui.workspaceTools")} className="workbench__tabs" role="tablist">
          {view.tools.map((tool, index) => {
            const toolId = toolRefId(tool);
            const label =
              tool.kind === "extension"
                ? (extensionViews.find(
                    (entry) => entry.extensionId === tool.extensionId && entry.id === tool.viewId,
                  )?.title ?? workbenchToolLabel(tool, t))
                : workbenchToolLabel(tool, t);
            const selected = view.selection.kind === "tool" && view.selection.toolId === toolId;
            const slot = index < SIDE_PANEL_TAB_SHORTCUT_SLOT_COUNT ? index + 1 : undefined;
            const shortcut = slot ? getSidePanelTabShortcutLabel(platform, slot) : undefined;
            return (
              <div className="workbench__tab-wrapper" key={toolId} role="presentation">
                <button
                  aria-controls={panelId}
                  aria-keyshortcuts={
                    slot ? `${platform === "darwin" ? "Control" : "Alt"}+${slot}` : undefined
                  }
                  aria-label={label}
                  aria-selected={selected}
                  className={`workbench__tab${selected ? " workbench__tab--active" : ""}`}
                  data-tab-shortcut={tabHintsVisible && slot ? String(slot) : undefined}
                  data-testid={`workbench-tab-${toolId}`}
                  disabled={loading}
                  id={tabId(toolId)}
                  onClick={() => onActivateTool(toolId)}
                  onKeyDown={(event) => onTabKeyDown(event, toolId)}
                  ref={(button) => {
                    if (button) tabRefs.current.set(toolId, button);
                    else tabRefs.current.delete(toolId);
                  }}
                  role="tab"
                  tabIndex={selected || (view.selection.kind === "chooser" && index === 0) ? 0 : -1}
                  title={shortcut ? `${label} (${shortcut})` : label}
                  type="button"
                >
                  {tabHintsVisible && shortcut ? (
                    <span className="workbench__tab-shortcut" aria-hidden="true">
                      {shortcut}
                    </span>
                  ) : (
                    <ToolIcon tool={tool} />
                  )}
                  <span>{label}</span>
                </button>
                <button
                  aria-label={t("ui.closeValueTab", { label: label })}
                  className="workbench__tab-close icon-button"
                  disabled={loading}
                  onClick={() => closeAndFocus(toolId)}
                  tabIndex={-1}
                  title={t("ui.closeValueTab", { label: label })}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <button
          aria-label={t("ui.addTab")}
          className="workbench__add icon-button"
          data-testid="workbench-add-tab"
          disabled={loading}
          onClick={onShowChooser}
          ref={addRef}
          title={t("ui.addTab")}
          type="button"
        >
          <PlusIcon />
        </button>
        <button
          aria-label={t("settings.shortcuts.toggleSidePanel")}
          aria-pressed="true"
          aria-controls="task-workbench"
          data-testid="toggle-side-panel"
          className="workbench__add icon-button"
          onClick={onTogglePanel}
          title={t("topbar.hideSidePanel")}
          type="button"
        >
          <SidePanelIcon />
        </button>
      </div>
      {error ? (
        <div className="workbench__error" role="status">
          <p>{error}</p>
          {loading && onRetryRestore ? (
            <button className="button" onClick={onRetryRestore} type="button">
              {t("ui.retryRestoringTabs")}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        aria-labelledby={activeTool ? tabId(toolRefId(activeTool)) : undefined}
        className="workbench__content"
        id={panelId}
        role={activeTool ? "tabpanel" : undefined}
      >
        {loading ? (
          <p className="workbench__loading" role="status">
            {error
              ? t("ui.savedTabsAreUnavailableUntilRestorationSucceeds")
              : t("ui.restoringToolTabs")}
          </p>
        ) : view.selection.kind === "chooser" ? (
          <div className="workbench__chooser" data-testid="workbench-chooser">
            <h2>{t("ui.openATool")}</h2>
            <p>{t("ui.keepTheToolsYouNeedAlongsideYourConversation")}</p>
            {builtinToolEntries(t).map(({ kind, label, description, Icon, shortcutKey }) => (
              <button
                aria-keyshortcuts={
                  shortcutKey
                    ? `${platform === "darwin" ? "Meta" : "Control"}+${shortcutKey}`
                    : undefined
                }
                aria-label={label}
                className="workbench__choice"
                key={kind}
                onClick={() => onOpenTool({ kind })}
                type="button"
              >
                <span className="workbench__choice-icon">
                  <Icon />
                </span>
                <span className="workbench__choice-copy">
                  <strong>{label}</strong>
                  <span>{description}</span>
                </span>
                {shortcutKey ? (
                  <kbd className="workbench__choice-shortcut">
                    {formatShortcut(platform, shortcutKey)}
                  </kbd>
                ) : null}
              </button>
            ))}
            <h3 className="workbench__extension-heading">{t("ui.extensionViews")}</h3>
            {extensionViewsLoading ? <p role="status">{t("ui.loadingExtensionViews")}</p> : null}
            {extensionViewsError ? (
              <div role="status">
                <p>{extensionViewsError}</p>
                {onReloadExtensionViews ? (
                  <button className="button" type="button" onClick={onReloadExtensionViews}>
                    {t("ui.refreshViews")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {extensionViews.map((extension) => (
              <button
                aria-label={extension.title}
                className="workbench__choice"
                key={toolRefId({
                  kind: "extension",
                  extensionId: extension.extensionId,
                  viewId: extension.id,
                })}
                onClick={() =>
                  onOpenTool({
                    kind: "extension",
                    extensionId: extension.extensionId,
                    viewId: extension.id,
                  })
                }
                type="button"
              >
                <span className="workbench__choice-icon">
                  <ExtensionIcon />
                </span>
                <span className="workbench__choice-copy">
                  <strong>{extension.title}</strong>
                  {extension.state === "error" ? (
                    <span>{extension.error ?? "View unavailable"}</span>
                  ) : null}
                </span>
              </button>
            ))}
            {!extensionViewsLoading && !extensionViewsError && extensionViews.length === 0 ? (
              <p>{t("ui.installedExtensionsCanProvideAdditionalViewsHere")}</p>
            ) : null}
          </div>
        ) : activeTool?.kind === "extension" && activeExtension?.state !== "ready" ? (
          <div className="workbench__unavailable" role="status">
            <ExtensionIcon />
            <h2>
              {extensionViewsLoading
                ? t("ui.findingThisExtensionView")
                : t("ui.thisExtensionViewIsUnavailable")}
            </h2>
            <p>
              {activeExtension?.error ||
                extensionViewsError ||
                "Your saved tab is retained. Extension commands can still be used when installed."}
            </p>
            {!extensionViewsLoading && onReloadExtensionViews ? (
              <button className="button" type="button" onClick={onReloadExtensionViews}>
                {t("ui.refreshViews")}
              </button>
            ) : null}
            <button
              className="button"
              onClick={() => closeAndFocus(toolRefId(activeTool))}
              type="button"
            >
              {t("ui.closeTab")}
            </button>
          </div>
        ) : (
          children
        )}
      </div>
    </aside>
  );
}
