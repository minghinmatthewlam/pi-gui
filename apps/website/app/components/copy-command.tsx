"use client";

import { useState } from "react";

export function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  const [program, ...rest] = command.split(" ");
  return (
    <div className="command">
      <code>
        <span className="command__program">{program}</span> {rest.join(" ")}
      </code>
      <button
        className="command__copy"
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => {
          navigator.clipboard.writeText(command).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            },
            () => setCopied(false),
          );
        }}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="5"
              y="5"
              width="8.5"
              height="8.5"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M10.5 3.5v-.5A1.5 1.5 0 009 1.5H3A1.5 1.5 0 001.5 3v6A1.5 1.5 0 003 10.5h.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
