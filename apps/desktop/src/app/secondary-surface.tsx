import type { ReactNode } from "react";

export interface SecondarySurfaceNavItem {
  readonly id: string;
  readonly label: string;
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
  return (
    <div className="secondary-surface" data-testid={testId}>
      <aside className="secondary-surface__sidebar">
        <button className="secondary-surface__back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span>
          <span>Back to app</span>
        </button>
        <div className="secondary-surface__title">{title}</div>
        {navItems.length > 0 ? (
          <nav className="secondary-surface__nav" aria-label={`${title} sections`}>
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`secondary-surface__nav-item ${activeNavId === item.id ? "secondary-surface__nav-item--active" : ""}`}
                type="button"
                onClick={() => onSelectNav?.(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        ) : null}
      </aside>
      <main className="secondary-surface__content">{children}</main>
    </div>
  );
}
