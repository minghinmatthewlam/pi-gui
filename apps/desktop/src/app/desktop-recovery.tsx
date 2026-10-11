import { Component, Fragment, type ReactNode } from "react";
import { translate, useTranslation, type Translate } from "../i18n";
import type { DesktopAppView, StateHydrationFailure } from "./desktop-app-state";

export type DesktopStartupSurfaceState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: StateHydrationFailure;
      readonly retrying: boolean;
    }
  | { readonly kind: "crashed" };

export interface DesktopStartupCopy {
  readonly title: string;
  readonly body: string;
  readonly status: "loading" | "failed" | "crashed";
}

/** Copy stays function-callable outside React; `t` defaults to English. */
export function startupSurfaceCopy(
  state: DesktopStartupSurfaceState,
  t: Translate = translate,
): DesktopStartupCopy {
  if (state.kind === "loading") {
    return {
      title: t("startup.loading.title"),
      body: t("startup.loading.body"),
      status: "loading",
    };
  }
  if (state.kind === "crashed") {
    return {
      title: t("startup.crashed.title"),
      body: t("startup.crashed.body"),
      status: "crashed",
    };
  }
  if (state.failure.code === "bridge-unavailable") {
    return {
      title: t("startup.failed.title"),
      body: t("startup.bridge.body"),
      status: "failed",
    };
  }
  return {
    title: t("startup.failed.title"),
    body: t("startup.failed.body"),
    status: "failed",
  };
}

export function rendererBoundaryCopy(t: Translate = translate): DesktopStartupCopy {
  return {
    title: t("startup.crashed.title"),
    body: t("startup.crashed.body"),
    status: "crashed",
  };
}

interface DesktopStartupSurfaceProps {
  readonly state: DesktopStartupSurfaceState;
  readonly onRetry: () => void;
  readonly onRelaunch?: () => void;
}

export function DesktopStartupSurface({ state, onRetry, onRelaunch }: DesktopStartupSurfaceProps) {
  const { t } = useTranslation();
  const copy = startupSurfaceCopy(state, t);
  const retrying = state.kind === "failed" ? state.retrying : false;
  const showActions = copy.status !== "loading";
  const showRelaunch =
    Boolean(onRelaunch) &&
    (state.kind === "crashed" ||
      (state.kind === "failed" && state.failure.code !== "bridge-unavailable"));

  return (
    <div className="shell shell--loading">
      <main
        className="loading-card"
        data-testid="shell-status-card"
        data-status={copy.status}
        data-retrying={retrying ? "true" : "false"}
        data-failure={state.kind === "failed" ? state.failure.code : undefined}
      >
        <div className="loading-card__eyebrow">pi-gui</div>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        {showActions ? (
          <div className="loading-card__actions">
            <button
              className="button button--primary"
              data-testid="hydrate-retry"
              type="button"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? t("startup.retrying") : t("startup.retry")}
            </button>
            {showRelaunch ? (
              <button
                className="button button--ghost"
                data-testid="hydrate-relaunch"
                type="button"
                onClick={onRelaunch}
              >
                {t("startup.relaunch")}
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

interface RendererErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onRelaunch?: () => void;
}

interface RendererErrorBoundaryState {
  readonly hasError: boolean;
  readonly remountKey: number;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { hasError: false, remountKey: 0 };

  static getDerivedStateFromError(): Pick<RendererErrorBoundaryState, "hasError"> {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[renderer] render tree failed", error);
  }

  private readonly handleRetry = (): void => {
    this.setState((current) => ({
      hasError: false,
      remountKey: current.remountKey + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <DesktopStartupSurface
          state={{ kind: "crashed" }}
          onRetry={this.handleRetry}
          onRelaunch={this.props.onRelaunch}
        />
      );
    }
    return <Fragment key={this.state.remountKey}>{this.props.children}</Fragment>;
  }
}

export function toStartupSurfaceState(view: DesktopAppView): DesktopStartupSurfaceState {
  if (view.kind === "failed") {
    return view;
  }
  return { kind: "loading" };
}
