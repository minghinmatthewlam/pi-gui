import { useState } from "react";
import type { TurnChangeSummary, TurnChangedFile } from "../../../contracts/review";
import { FileDiffIcon } from "../../ui/icons";

const COLLAPSED_FILE_COUNT = 5;

export type OpenTurnChange = (turn: TurnChangeSummary, path: string) => void;

/** The files one agent turn changed; each row opens that file's diff in the Changes panel. */
export function TurnChangesCard({
  turn,
  onOpen,
}: {
  readonly turn: TurnChangeSummary;
  readonly onOpen?: OpenTurnChange;
}) {
  const [expanded, setExpanded] = useState(false);
  const { files } = turn;
  const hidden = expanded ? 0 : Math.max(0, files.length - COLLAPSED_FILE_COUNT);
  const shown = hidden ? files.slice(0, COLLAPSED_FILE_COUNT) : files;
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + (file.lines?.added ?? 0),
      removed: sum.removed + (file.lines?.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
  const firstFile = files[0];

  return (
    <section
      className="turn-changes"
      aria-label="Files changed in this turn"
      data-testid="turn-changes"
    >
      <header className="turn-changes__header">
        <span className="turn-changes__glyph" aria-hidden="true">
          <FileDiffIcon />
        </span>
        <div className="turn-changes__summary">
          <span className="turn-changes__title">
            {`Edited ${files.length} ${files.length === 1 ? "file" : "files"}`}
          </span>
          <LineStats lines={totals} />
        </div>
        {firstFile && onOpen ? (
          <button
            type="button"
            className="turn-changes__review"
            onClick={() => onOpen(turn, firstFile.path)}
          >
            Review
          </button>
        ) : null}
      </header>
      <ul className="turn-changes__files">
        {shown.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="turn-changes__file"
              data-file-path={file.path}
              disabled={!onOpen}
              title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
              onClick={() => onOpen?.(turn, file.path)}
            >
              <FilePath path={file.path} />
              <FileStats file={file} />
            </button>
          </li>
        ))}
        {hidden ? (
          <li>
            <button
              type="button"
              className="turn-changes__file turn-changes__more"
              onClick={() => setExpanded(true)}
            >
              {`Show ${hidden} more`}
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function FilePath({ path }: { readonly path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="turn-changes__path">
      {slash >= 0 ? <span className="turn-changes__dir">{path.slice(0, slash + 1)}</span> : null}
      <span className="turn-changes__name">{path.slice(slash + 1)}</span>
    </span>
  );
}

function FileStats({ file }: { readonly file: TurnChangedFile }) {
  return file.lines ? (
    <LineStats lines={file.lines} />
  ) : (
    <span className="turn-changes__stats turn-changes__binary">Binary</span>
  );
}

function LineStats({
  lines,
}: {
  readonly lines: { readonly added: number; readonly removed: number };
}) {
  return (
    <span className="turn-changes__stats">
      <span className="turn-changes__added">+{lines.added}</span>
      <span className="turn-changes__removed">-{lines.removed}</span>
    </span>
  );
}
