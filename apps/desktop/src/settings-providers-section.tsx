import { useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { SettingsIcon, StatusIcon } from "./icons";
import { filterProviders, ProviderRow, SettingsCard } from "./settings-utils";

interface SettingsProvidersSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
}

export function SettingsProvidersSection({ runtime, onLoginProvider, onLogoutProvider }: SettingsProvidersSectionProps) {
  const [providerQuery, setProviderQuery] = useState("");

  const providers = runtime?.providers ?? [];
  const connectedProviders = providers.filter((p) => p.hasAuth);
  const oauthProviders = providers.filter((p) => p.oauthSupported);
  const filteredProviders = filterProviders(providers, providerQuery);

  return (
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
        <details className="settings-disclosure">
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
  );
}
