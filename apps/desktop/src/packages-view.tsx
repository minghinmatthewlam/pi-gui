import { useMemo, useState } from "react";
import type { RuntimePackageRecord } from "@pi-gui/session-driver/runtime-types";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "./desktop-state";
import { RefreshIcon } from "./icons";

type SortKey = "name" | "kind" | "scope" | "extensions" | "skills";

interface PackagesViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly onRefresh: () => void;
}

export function PackagesView({
  workspace,
  runtime,
  onRefresh,
}: PackagesViewProps) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selectedPackageSource, setSelectedPackageSource] = useState<string | undefined>();

  const packages = runtime?.packages ?? [];

  const filteredPackages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let results = normalized
      ? packages.filter((pkg) =>
          [pkg.displayName, pkg.source, pkg.kind, pkg.scope, pkg.description]
            .some((value) => value?.toLowerCase().includes(normalized)),
        )
      : [...packages];

    results.sort((left, right) => {
      switch (sortKey) {
        case "name":
          return left.displayName.localeCompare(right.displayName);
        case "kind":
          return left.kind.localeCompare(right.kind) || left.displayName.localeCompare(right.displayName);
        case "scope":
          return left.scope.localeCompare(right.scope) || left.displayName.localeCompare(right.displayName);
        case "extensions":
          return (
            right.extensionCount - left.extensionCount ||
            left.displayName.localeCompare(right.displayName)
          );
        case "skills":
          return (
            right.skillCount - left.skillCount ||
            left.displayName.localeCompare(right.displayName)
          );
        default:
          return 0;
      }
    });

    return results;
  }, [packages, query, sortKey]);

  const selectedPackage =
    filteredPackages.find((pkg) => pkg.source === selectedPackageSource) ?? filteredPackages[0];

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">Packages</div>
          <h1>Select a workspace</h1>
          <p>Packages are loaded from user and project settings. Select a workspace to browse them.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation skills-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">Packages</div>
            <h1 className="view-header__title">Packages</h1>
            <p className="view-header__body">
              Installed pi packages that contribute extensions, skills, prompt templates, and themes.
            </p>
          </div>
          <div className="view-header__actions">
            <button className="button button--secondary" type="button" onClick={onRefresh}>
              <RefreshIcon />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <div className="skills-toolbar">
          <input
            aria-label="Search packages"
            className="skills-search"
            placeholder="Search packages by name, source, or kind"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <SortSelector sortKey={sortKey} onSortChange={setSortKey} />
        </div>

        <div className="skills-layout">
          <div className="skills-grid" data-testid="packages-list">
            {filteredPackages.length === 0 ? (
              <PackagesEmptyState message="No installed packages found. Install packages with pi install from npm or git." />
            ) : (
              filteredPackages.map((pkg) => (
                <button
                  className={`skill-card ${selectedPackage?.source === pkg.source ? "skill-card--active" : ""}`}
                  key={pkg.source}
                  type="button"
                  onClick={() => {
                    setSelectedPackageSource(pkg.source);
                  }}
                >
                  <span className="skill-card__title-row">
                    <span className="skill-card__title">{pkg.displayName}</span>
                    <span className="skill-card__badge skill-card__badge--enabled">
                      Installed
                    </span>
                  </span>
                  <span className="skill-card__description">{pkg.source}</span>
                  <span className="skill-card__meta">
                    <span>{pkg.kind}</span>
                    <span>{pkg.scope}</span>
                    <PackageCountLabel pkg={pkg} />
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="skill-detail">
            {selectedPackage ? (
              <>
                <div className="skill-detail__header">
                  <div>
                    <h2>{selectedPackage.displayName}</h2>
                    <div className="skill-detail__slash">{selectedPackage.source}</div>
                  </div>
                </div>
                <div className="skill-detail__meta-list">
                  <PackageDetailItem label="Kind" value={kindLabel(selectedPackage.kind)} />
                  <PackageDetailItem label="Scope" value={scopeLabel(selectedPackage.scope)} />
                  <PackageDetailItem label="Source" value={selectedPackage.source} mono />
                </div>
                <div className="skill-detail__meta-list">
                  <PackageDetailItem
                    label="Resources contributed"
                    value={contributedSummary(selectedPackage)}
                  />
                </div>
                {selectedPackage.extensionCount > 0 ? (
                  <div className="skill-detail__meta-list">
                    <div>
                      <div className="skill-detail__meta-label">Extensions</div>
                      <div className="skill-detail__description">
                        {selectedPackage.extensionCount} extension{selectedPackage.extensionCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                ) : null}
                {selectedPackage.skillCount > 0 ? (
                  <div className="skill-detail__meta-list">
                    <div>
                      <div className="skill-detail__meta-label">Skills</div>
                      <div className="skill-detail__description">
                        {selectedPackage.skillCount} skill{selectedPackage.skillCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                ) : null}
                {selectedPackage.promptCount > 0 ? (
                  <div className="skill-detail__meta-list">
                    <div>
                      <div className="skill-detail__meta-label">Prompt templates</div>
                      <div className="skill-detail__description">
                        {selectedPackage.promptCount} template{selectedPackage.promptCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                ) : null}
                {selectedPackage.themeCount > 0 ? (
                  <div className="skill-detail__meta-list">
                    <div>
                      <div className="skill-detail__meta-label">Themes</div>
                      <div className="skill-detail__description">
                        {selectedPackage.themeCount} theme{selectedPackage.themeCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="skill-detail__actions">
                  <button className="button button--secondary" type="button" disabled>
                    Manage in terminal
                  </button>
                </div>
              </>
            ) : (
              <PackagesEmptyState message="Select a package to view details about its installed resources." />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PackageCountLabel({ pkg }: { readonly pkg: RuntimePackageRecord }) {
  const parts: string[] = [];
  if (pkg.extensionCount > 0) parts.push(`${pkg.extensionCount} ext`);
  if (pkg.skillCount > 0) parts.push(`${pkg.skillCount} skill`);
  if (parts.length === 0) parts.push("No resources");
  return <span>{parts.join(", ")}</span>;
}

function contributedSummary(pkg: RuntimePackageRecord): string {
  const parts: string[] = [];
  if (pkg.extensionCount > 0) parts.push(`${pkg.extensionCount} extension${pkg.extensionCount !== 1 ? "s" : ""}`);
  if (pkg.skillCount > 0) parts.push(`${pkg.skillCount} skill${pkg.skillCount !== 1 ? "s" : ""}`);
  if (pkg.promptCount > 0) parts.push(`${pkg.promptCount} prompt template${pkg.promptCount !== 1 ? "s" : ""}`);
  if (pkg.themeCount > 0) parts.push(`${pkg.themeCount} theme${pkg.themeCount !== 1 ? "s" : ""}`);
  return parts.length > 0 ? parts.join(", ") : "No resources contributed";
}

function kindLabel(kind: RuntimePackageRecord["kind"]): string {
  switch (kind) {
    case "npm":
      return "npm";
    case "git":
      return "Git";
    case "local":
      return "Local";
  }
}

function scopeLabel(scope: RuntimePackageRecord["scope"]): string {
  return scope === "user" ? "User (global)" : "Project (local)";
}

function PackageDetailItem({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <div className="skill-detail__meta-label">{label}</div>
      <div className={mono ? "skill-detail__path" : "skill-detail__description"}>
        {value}
      </div>
    </div>
  );
}

function SortSelector({
  sortKey,
  onSortChange,
}: {
  readonly sortKey: SortKey;
  readonly onSortChange: (key: SortKey) => void;
}) {
  const options: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "kind", label: "Kind" },
    { key: "scope", label: "Scope" },
    { key: "extensions", label: "Extensions" },
    { key: "skills", label: "Skills" },
  ];

  return (
    <div className="package-sort">
      <span className="package-sort__label">Sort:</span>
      <div className="package-sort__pills">
        {options.map((option) => (
          <button
            key={option.key}
            className={`package-sort__pill ${sortKey === option.key ? "package-sort__pill--active" : ""}`}
            type="button"
            onClick={() => onSortChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PackagesEmptyState({ message }: { readonly message: string }) {
  return (
    <div className="empty-state">
      <h2>No packages found</h2>
      <p>{message}</p>
    </div>
  );
}
