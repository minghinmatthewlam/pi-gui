import { useMemo } from "react";
import { HighlightedLine } from "./highlighted-line";
import { MAX_HIGHLIGHTED_LINES } from "./syntax-highlight";

interface DiffLine {
  readonly type: "added" | "removed" | "context" | "header" | "unmodified";
  readonly content: string;
  readonly lineNumber?: number;
}

export function InlineDiff({
  diff,
  language,
  unmodifiedGaps = false,
}: {
  readonly diff: string;
  readonly language?: string;
  /** Replace hunk headers with "N unmodified lines" rows for the new-file lines they skip. */
  readonly unmodifiedGaps?: boolean;
}) {
  const lines = useMemo(() => parseDiff(diff, unmodifiedGaps), [diff, unmodifiedGaps]);
  const highlightActive = language !== undefined && lines.length <= MAX_HIGHLIGHTED_LINES;

  if (lines.length === 0) {
    return null;
  }

  return (
    <pre className="diff-inline" data-language={highlightActive ? language : undefined}>
      {lines.map((line, index) => (
        <div className={`diff-line diff-line--${line.type}`} key={index}>
          {line.lineNumber !== undefined ? (
            <span className="diff-line__number">{line.lineNumber}</span>
          ) : (
            <span className="diff-line__number" />
          )}
          <span className="diff-line__content">
            {highlightActive && line.type !== "header" && line.type !== "unmodified" ? (
              <HighlightedLine content={line.content} language={language!} />
            ) : (
              line.content
            )}
          </span>
        </div>
      ))}
    </pre>
  );
}

function parseDiff(diff: string, unmodifiedGaps: boolean): DiffLine[] {
  const lines = diff.split("\n");
  // A patch ends with a newline; that final empty piece is not a blank context line.
  if (lines.at(-1) === "") lines.pop();
  const result: DiffLine[] = [];
  let lineNumber = 0;
  // The next new-file line not yet shown, so a hunk header can count the lines it skips.
  let nextUnshown = 1;
  // File headers only come before a file's first hunk; inside one, "---" is a removed "--" line.
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      lineNumber = match ? parseInt(match[1] ?? "0", 10) : 0;
      if (!unmodifiedGaps) {
        result.push({ type: "header", content: line });
        continue;
      }
      // A hunk that only deletes reports the line before it, so it skips one line fewer.
      const deletesOnly = /^@@ -\d+(?:,\d+)? \+\d+,0 /.test(line);
      const skipped = lineNumber + (deletesOnly ? 1 : 0) - nextUnshown;
      if (skipped > 0)
        result.push({
          type: "unmodified",
          content: `${skipped} unmodified ${skipped === 1 ? "line" : "lines"}`,
        });
      if (deletesOnly) lineNumber += 1;
      nextUnshown = lineNumber;
      continue;
    }
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) {
      continue;
    }
    if (line.startsWith("+")) {
      result.push({ type: "added", content: line.slice(1), lineNumber });
      lineNumber += 1;
      nextUnshown = lineNumber;
    } else if (line.startsWith("-")) {
      result.push({ type: "removed", content: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      result.push({ type: "context", content: line.slice(1), lineNumber });
      lineNumber += 1;
      nextUnshown = lineNumber;
    }
  }

  return result;
}

export function extractDiffFromOutput(output: unknown): string | undefined {
  if (typeof output === "string" && (output.includes("@@") || output.startsWith("diff "))) {
    return output;
  }
  if (isObj(output)) {
    if (typeof output.diff === "string") {
      return output.diff;
    }
    if (isObj(output.details) && typeof output.details.diff === "string") {
      return output.details.diff;
    }
    if (Array.isArray(output.content)) {
      for (const part of output.content) {
        if (isObj(part) && part.type === "text" && typeof part.text === "string") {
          if (part.text.includes("@@") || part.text.startsWith("diff ")) {
            return part.text;
          }
        }
      }
    }
  }
  return undefined;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
