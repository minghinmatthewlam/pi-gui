import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "../../ui/icons";

export interface ReviewMenuOption {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  /** Draws a divider above this option, grouping it with the options after it. */
  readonly startsGroup?: boolean;
}

interface ReviewMenuProps {
  readonly label: string;
  readonly buttonClassName: string;
  readonly buttonContent: ReactNode;
  readonly align: "start" | "end";
  readonly options: readonly ReviewMenuOption[];
  readonly onSelect: (id: string) => void;
  /** Read-only lines shown above the options, such as the resolved comparison. */
  readonly details?: readonly string[];
}

/** A small single-choice popover menu for the Review toolbar. */
export function ReviewMenu({
  label,
  buttonClassName,
  buttonContent,
  align,
  options,
  onSelect,
  details,
}: ReviewMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div className="review-menu" ref={rootRef}>
      <button
        className={buttonClassName}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {buttonContent}
      </button>
      {open ? (
        <div
          className={`workspace-menu review-menu__popover review-menu__popover--${align}`}
          role="menu"
          aria-label={label}
        >
          {details?.length ? (
            <div className="review-menu__details" data-testid="review-comparison-identity">
              {details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </div>
          ) : null}
          {options.map((option) => (
            <Fragment key={option.id}>
              {option.startsGroup ? (
                <div className="review-menu__divider" role="separator" />
              ) : null}
              <button
                className="workspace-menu__item review-menu__item"
                type="button"
                role="menuitemradio"
                aria-checked={option.checked}
                data-option-id={option.id}
                onClick={() => {
                  setOpen(false);
                  onSelect(option.id);
                }}
              >
                <span>{option.label}</span>
                {option.checked ? <CheckIcon /> : null}
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
