import { useMemo } from "react";
import { useActiveTheme } from "./active-theme";
import { highlightLine, useHighlighterReady } from "./syntax-highlight";

/** One line of code coloured by the active theme's syntax theme. */
export function HighlightedLine({
  content,
  language,
}: {
  readonly content: string;
  readonly language: string;
}) {
  const { syntaxTheme } = useActiveTheme();
  const ready = useHighlighterReady();
  const tokens = useMemo(
    () => (ready ? highlightLine(content, language, syntaxTheme) : null),
    [content, language, syntaxTheme, ready],
  );
  if (!tokens) return <>{content}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.color || token.fontStyle ? (
          <span key={index} style={{ color: token.color, fontStyle: token.fontStyle }}>
            {token.content}
          </span>
        ) : (
          token.content
        ),
      )}
    </>
  );
}
