import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NewThreadEnvironment } from "../../../contracts/desktop-state";
import { trapDialogFocus } from "../../ui/dialog-focus";

interface ForkModalProps {
  readonly submitting: boolean;
  readonly error?: string;
  /** Preview of the assistant response the fork will branch after. */
  readonly messagePreview?: string;
  /** Whether forking into a new worktree is available for the source workspace. */
  readonly canUseWorktree: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (environment: NewThreadEnvironment) => void;
}

export function ForkModal({
  submitting,
  error,
  messagePreview,
  canUseWorktree,
  onClose,
  onSubmit,
}: ForkModalProps) {
  const [environment, setEnvironment] = useState<NewThreadEnvironment>("local");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-fork-confirm='true']")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }

    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || submitting) {
          return;
        }
        onClose();
      }}
    >
      <div
        aria-modal="true"
        className="tree-modal tree-modal--compact"
        data-testid="fork-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">Fork conversation</div>
            <h2 className="tree-modal__title">Start a new thread</h2>
          </div>
          <button
            aria-label="Close fork modal"
            className="tree-modal__close"
            disabled={submitting}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="tree-modal__error error-banner" data-testid="fork-modal-error">
            {error}
          </div>
        ) : null}

        <div className="tree-modal__summary-step">
          <div className="tree-modal__summary-copy">
            Forks the conversation up to and including this response into a new sidebar thread with
            an empty composer, so you can continue it in a different direction. The original thread
            stays untouched.
          </div>

          {messagePreview ? (
            <div className="fork-modal__preview" data-testid="fork-modal-preview">
              {messagePreview}
            </div>
          ) : null}

          <div
            className="new-thread__environment-group"
            role="radiogroup"
            aria-label="Fork environment"
          >
            <button
              aria-pressed={environment === "local"}
              className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
              data-testid="fork-environment-local"
              type="button"
              onClick={() => setEnvironment("local")}
            >
              <span>Same worktree</span>
            </button>
            <button
              aria-pressed={environment === "worktree"}
              className={`new-thread__environment ${environment === "worktree" ? "new-thread__environment--active" : ""}`}
              data-testid="fork-environment-worktree"
              disabled={!canUseWorktree}
              title={canUseWorktree ? undefined : "This workspace can't create worktrees."}
              type="button"
              onClick={() => setEnvironment("worktree")}
            >
              <span>New worktree</span>
            </button>
          </div>

          <div className="tree-modal__footer">
            <div className="tree-modal__hint">
              {environment === "worktree"
                ? "A fresh worktree is created and the forked thread opens there."
                : "The forked thread opens in the same folder as the original."}
            </div>
            <div className="tree-modal__actions">
              <button
                className="button button--secondary"
                disabled={submitting}
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                data-fork-confirm="true"
                data-testid="fork-modal-confirm"
                disabled={submitting}
                type="button"
                onClick={() => onSubmit(environment)}
              >
                {submitting ? "Forking…" : "Fork thread"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
