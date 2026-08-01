import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const code = String(children).replace(/\n$/, "");
    return <code className={className}>{code}</code>;
  },
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
} as const;

// Memoized: remark parsing is the dominant render cost on long threads, and the
// timeline re-renders on every streaming tick. `text` is a string, so shallow
// comparison skips the re-parse for every message except the one still growing.
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="message__content">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
