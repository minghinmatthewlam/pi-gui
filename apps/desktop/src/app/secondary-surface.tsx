import { useEffect, useRef, useState, type ReactNode } from "react";
import { SearchIcon } from "../ui/icons";

export interface SecondarySurfaceNavItem {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon: ReactNode;
  /** Extra search terms, such as the titles of the rows on that page. */
  readonly keywords: readonly string[];
}

interface SecondarySurfaceProps {
  readonly title: string;
  readonly onBack: () => void;
  readonly navItems?: readonly SecondarySurfaceNavItem[];
  readonly activeNavId?: string;
  readonly onSelectNav?: (id: string) => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function SecondarySurface({
  title,
  onBack,
  navItems = [],
  activeNavId,
  onSelectNav,
  testId,
  children,
}: SecondarySurfaceProps) {
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat)
        return;
      // Nested dialogs own Escape, including while a pending operation disables dismissal.
      if (document.querySelector("[aria-modal='true'], .extension-dialog-backdrop")) return;
      event.preventDefault();
      backRef.current();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  return (
    <div className="secondary-surface" data-testid={testId}>
      <aside className="secondary-surface__sidebar">
        <button className="secondary-surface__back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span>
          <span>Back to app</span>
        </button>
        {navItems.length > 0 ? (
          <SecondarySurfaceNav
            activeNavId={activeNavId}
            items={navItems}
            label={`${title} sections`}
            searchLabel={`Search ${title.toLowerCase()}`}
            onSelect={(id) => onSelectNav?.(id)}
          />
        ) : (
          <div className="secondary-surface__title">{title}</div>
        )}
      </aside>
      <main className="secondary-surface__content">{children}</main>
    </div>
  );
}

function SecondarySurfaceNav({
  items,
  activeNavId,
  label,
  searchLabel,
  onSelect,
}: {
  readonly items: readonly SecondarySurfaceNavItem[];
  readonly activeNavId?: string;
  readonly label: string;
  readonly searchLabel: string;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = filterNavItems(items, query);
  const groups = [...new Set(matches.map((item) => item.group))];

  return (
    <>
      <label className="secondary-surface__search">
        <SearchIcon />
        <input
          aria-label={searchLabel}
          placeholder="Search"
          spellCheck={false}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              onSelect(matches[0].id);
            }
            // The first Escape clears the search; the next one leaves the surface.
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </label>
      <nav aria-label={label} className="secondary-surface__nav">
        {groups.map((group) => (
          <div className="secondary-surface__nav-group" key={group}>
            <div className="secondary-surface__nav-group-label">{group}</div>
            {matches
              .filter((item) => item.group === group)
              .map((item) => (
                <button
                  key={item.id}
                  aria-current={activeNavId === item.id ? "page" : undefined}
                  className={`secondary-surface__nav-item ${activeNavId === item.id ? "secondary-surface__nav-item--active" : ""}`}
                  type="button"
                  onClick={() => onSelect(item.id)}
                >
                  <span className="secondary-surface__nav-icon">{item.icon}</span>
                  <span>{item.title}</span>
                </button>
              ))}
          </div>
        ))}
        {matches.length === 0 ? (
          <p className="secondary-surface__nav-empty">No matches for “{query.trim()}”</p>
        ) : null}
      </nav>
    </>
  );
}

function filterNavItems(
  items: readonly SecondarySurfaceNavItem[],
  query: string,
): readonly SecondarySurfaceNavItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return items;
  }
  return items.filter((item) => {
    const haystack = [item.title, item.group, ...item.keywords].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
