import type { ReactNode } from "react";
import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

export type SettingsSection = "general" | "providers" | "models" | "notifications";

export const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export function settingsPill(active: boolean): string {
  return `settings-pill${active ? " settings-pill--active" : ""}`;
}

export function labelForThinking(level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>): string {
  if (level === "xhigh") {
    return "Extra High";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function sectionTitle(section: SettingsSection): string {
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

export function sectionDescription(section: SettingsSection, workspaceName: string): string {
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

export function filterProviders(
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

export function SettingsCard({
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

export function SettingsInfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="settings-list__row">
      <div className="settings-list__body">
        <div className="settings-list__title">{label}</div>
        <div className="settings-list__meta">{value}</div>
      </div>
    </div>
  );
}

export function ProviderRow({
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
