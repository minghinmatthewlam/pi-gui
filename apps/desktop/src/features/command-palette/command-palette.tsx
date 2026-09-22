import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { SearchIcon } from "../../ui/icons";

export interface PaletteItem {
  readonly id: string;
  readonly title: string;
  readonly titleMatches?: readonly number[];
  readonly detail?: string;
  readonly detailMatches?: readonly number[];
  readonly icon: ReactNode;
  readonly hint?: string;
  readonly run: () => void;
}

export interface PaletteSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly PaletteItem[];
}

export interface PaletteFilter<F extends string> {
  readonly id: F;
  readonly label: string;
}

interface CommandPaletteProps<F extends string> {
  readonly label: string;
  readonly placeholder: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly sections: readonly PaletteSection[];
  /** Shown in place of results when there are no items. */
  readonly emptyText: string;
  readonly filters?: readonly PaletteFilter<F>[];
  readonly activeFilter?: F;
  readonly onFilterChange?: (filter: F) => void;
  /** Results still reflect an older query; Enter waits until they catch up. */
  readonly settling?: boolean;
  /** Backspace on an empty query goes here, for nested lists. */
  readonly onBack?: () => void;
  readonly onClose: () => void;
}

export function CommandPalette<F extends string>({
  label,
  placeholder,
  query,
  onQueryChange,
  sections,
  emptyText,
  filters,
  activeFilter,
  onFilterChange,
  settling = false,
  onBack,
  onClose,
}: CommandPaletteProps<F>) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [enterQueued, setEnterQueued] = useState(false);
  const items = sections.flatMap((section) => section.items);
  const activePosition = Math.min(activeIndex, items.length - 1);
  const active = items[activePosition];
  // Item ids can hold paths with spaces, so DOM ids use the position instead.
  const optionId = (position: number) => `${listId}-option-${position}`;

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const focusIsLost =
        !document.activeElement ||
        document.activeElement === document.body ||
        !document.activeElement.isConnected;
      if (focusIsLost && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, activeFilter, label]);

  useEffect(() => {
    if (enterQueued && !settling) {
      setEnterQueued(false);
      active?.run();
    }
  }, [active, enterQueued, settling]);

  // Keyed on the position, not the item: items are rebuilt on every app render.
  useLayoutEffect(() => {
    document.getElementById(optionId(activePosition))?.scrollIntoView({ block: "nearest" });
  }, [activePosition, query, activeFilter, label]);

  const cycleFilter = (step: 1 | -1) => {
    if (!filters || filters.length === 0 || !onFilterChange) {
      return;
    }
    const current = filters.findIndex((filter) => filter.id === activeFilter);
    const next = filters[(current + step + filters.length) % filters.length];
    if (next) {
      onFilterChange(next.id);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (items.length === 0) {
          return;
        }
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => {
          const from = Math.min(current, items.length - 1);
          return (from + step + items.length) % items.length;
        });
        return;
      }
      case "Enter":
        event.preventDefault();
        if (settling) {
          setEnterQueued(true);
        } else {
          active?.run();
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      case "Tab":
        // Ctrl+Tab belongs to thread switching; leave it to the app.
        if (event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
        event.preventDefault();
        cycleFilter(event.shiftKey ? -1 : 1);
        return;
      case "Backspace":
        if (query === "" && onBack) {
          event.preventDefault();
          onBack();
        }
        return;
      default:
    }
  };

  let itemIndex = -1;
  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-label={label}
        aria-modal="true"
        className="command-palette"
        data-testid="command-palette"
        role="dialog"
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette__search">
          <span className="command-palette__search-icon">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            aria-activedescendant={active ? optionId(activePosition) : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label={placeholder}
            className="command-palette__input"
            data-testid="command-palette-input"
            placeholder={placeholder}
            role="combobox"
            spellCheck={false}
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button
            aria-label="Close"
            className="command-palette__close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {filters && filters.length > 0 ? (
          <div aria-label="Filters" className="command-palette__filters" role="tablist">
            {filters.map((filter) => (
              <button
                key={filter.id}
                aria-selected={filter.id === activeFilter}
                className={`command-palette__filter${filter.id === activeFilter ? " command-palette__filter--active" : ""}`}
                role="tab"
                tabIndex={-1}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onFilterChange?.(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="command-palette__results" id={listId} role="listbox">
          {items.length === 0 ? (
            <div className="command-palette__empty" data-testid="command-palette-empty">
              {emptyText}
            </div>
          ) : (
            sections.map((section) =>
              section.items.length === 0 ? null : (
                <div
                  key={section.id}
                  aria-labelledby={`${listId}-section-${section.id}`}
                  className="command-palette__section"
                  role="group"
                >
                  <div
                    className="command-palette__section-label"
                    id={`${listId}-section-${section.id}`}
                  >
                    {section.label}
                  </div>
                  {section.items.map((item) => {
                    itemIndex += 1;
                    const index = itemIndex;
                    const selected = item === active;
                    return (
                      <div
                        key={item.id}
                        aria-selected={selected}
                        className={`command-palette__item${selected ? " command-palette__item--active" : ""}`}
                        id={optionId(index)}
                        role="option"
                        onClick={() => item.run()}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!selected) setActiveIndex(index);
                        }}
                      >
                        <span className="command-palette__item-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span className="command-palette__item-text">
                          <span className="command-palette__item-title">
                            <HighlightedText text={item.title} positions={item.titleMatches} />
                          </span>
                          {item.detail ? (
                            <span className="command-palette__item-detail">
                              <HighlightedText text={item.detail} positions={item.detailMatches} />
                            </span>
                          ) : null}
                        </span>
                        {item.hint ? (
                          <kbd className="command-palette__item-hint">{item.hint}</kbd>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ),
            )
          )}
        </div>

        <div className="command-palette__footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          {filters && filters.length > 0 ? (
            <span>
              <kbd>Tab</kbd> Filters
            </span>
          ) : null}
          {onBack ? (
            <span>
              <kbd>⌫</kbd> Back
            </span>
          ) : null}
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}

function HighlightedText({
  text,
  positions,
}: {
  readonly text: string;
  readonly positions?: readonly number[];
}) {
  if (!positions || positions.length === 0) {
    return <>{text}</>;
  }
  const marked = new Set(positions);
  const parts: ReactNode[] = [];
  let start = 0;
  while (start < text.length) {
    const isMatch = marked.has(start);
    let end = start + 1;
    while (end < text.length && marked.has(end) === isMatch) {
      end += 1;
    }
    const slice = text.slice(start, end);
    parts.push(isMatch ? <mark key={start}>{slice}</mark> : slice);
    start = end;
  }
  return <>{parts}</>;
}
