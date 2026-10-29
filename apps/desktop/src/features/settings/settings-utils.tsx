import type { ReactNode } from "react";
import type {
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import { useTranslation, type MessageKey, type Translate } from "../../i18n";

export const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_LABEL_KEYS: Readonly<
  Record<NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>, MessageKey>
> = {
  off: "settings.thinking.off",
  minimal: "settings.thinking.minimal",
  low: "settings.thinking.low",
  medium: "settings.thinking.medium",
  high: "settings.thinking.high",
  xhigh: "settings.thinking.xhigh",
  max: "settings.thinking.max",
};

export function labelForThinking(
  level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  t: Translate,
): string {
  return t(THINKING_LABEL_KEYS[level]);
}

export function filterProviders(
  providers: readonly RuntimeSnapshot["providers"][number][],
  query: string,
): readonly RuntimeSnapshot["providers"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return providers;
  }
  return providers.filter((provider) =>
    [provider.id, provider.name, provider.authType].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function filterModels(
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

/* ── Layout components ────────────────────────────────── */

export function SettingsGroup({
  title,
  description,
  plain = false,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  /** Lay children out without the rounded card, for tiles and other custom content. */
  readonly plain?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-section">
      {title ? <h3 className="settings-section__title">{title}</h3> : null}
      {description ? <p className="settings-section__description">{description}</p> : null}
      {plain ? children : <div className="settings-group">{children}</div>}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{title}</div>
        {description ? <div className="settings-row__description">{description}</div> : null}
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

export function ProviderRow({
  provider,
  onLoginProvider,
  onLogoutProvider,
  onConfigureApiKey,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void;
}) {
  const { t } = useTranslation();
  const actions = resolveProviderActions(
    provider,
    t,
    onLoginProvider,
    onLogoutProvider,
    onConfigureApiKey,
  );
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{provider.name}</div>
        <div className="settings-row__description">{describeProviderStatus(provider, t)}</div>
      </div>
      {actions.length > 0 ? (
        <div className="settings-row__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className="button button--secondary"
              disabled={action.disabled}
              type="button"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function describeProviderStatus(
  provider: RuntimeSnapshot["providers"][number],
  t: Translate,
): string {
  switch (provider.authSource) {
    case "oauth":
      return t("settings.provider.status.oauth");
    case "auth_file":
      return t("settings.provider.status.authFile");
    case "env":
      return t("settings.provider.status.env");
    case "external":
      return provider.hasAuth
        ? t("settings.provider.status.externalConnected")
        : t("settings.provider.status.configureExternally");
    default:
      if (provider.oauthSupported) {
        return provider.apiKeySetupSupported
          ? t("settings.provider.status.oauthOrApiKey")
          : t("settings.provider.status.oauthOnly");
      }
      if (provider.apiKeySetupSupported) {
        return t("settings.provider.status.apiKey");
      }
      return provider.authType === "api_key"
        ? t("settings.provider.status.apiKey")
        : t("settings.provider.status.builtIn");
  }
}

interface ProviderAction {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick?: () => void;
}

/** A provider with both sign-in and API keys (OpenAI, OpenRouter, xAI) offers both until connected. */
function resolveProviderActions(
  provider: RuntimeSnapshot["providers"][number],
  t: Translate,
  onLoginProvider: (providerId: string) => void,
  onLogoutProvider: (providerId: string) => void,
  onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void,
): readonly ProviderAction[] {
  if (provider.authSource === "oauth") {
    return [
      {
        disabled: false,
        label: t("settings.provider.action.logout"),
        onClick: () => onLogoutProvider(provider.id),
      },
    ];
  }

  const actions: ProviderAction[] = [];
  if (provider.oauthSupported && provider.authSource === "none") {
    actions.push({
      disabled: false,
      label: t("settings.provider.action.login"),
      onClick: () => onLoginProvider(provider.id),
    });
  }
  if (
    provider.apiKeySetupSupported &&
    (provider.authSource === "none" || provider.authSource === "auth_file")
  ) {
    actions.push({
      disabled: false,
      label:
        provider.authSource === "auth_file"
          ? t("settings.provider.action.manage")
          : t("settings.provider.action.setApiKey"),
      onClick: () => onConfigureApiKey(provider),
    });
  }
  if (actions.length > 0 || provider.authSource === "env" || provider.authSource === "external") {
    return actions;
  }

  return [{ disabled: true, label: t("settings.provider.status.configureExternally") }];
}
