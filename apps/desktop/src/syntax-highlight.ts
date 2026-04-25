import { LRUCache } from "lru-cache";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);

export const MAX_HIGHLIGHTED_LINES = 500;

interface HighlightToken {
  readonly className?: string;
  readonly children: HighlightLine;
}

export type HighlightTokenChild = string | HighlightToken;

export type HighlightLine = readonly HighlightTokenChild[];

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

export function extensionToLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) return undefined;
  const ext = filePath.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}

const lineCache = new LRUCache<string, HighlightLine>({ max: 5000 });

export function highlightLine(line: string, language: string): HighlightLine {
  const cacheKey = `${language}\0${line}`;
  const cached = lineCache.get(cacheKey);
  if (cached) return cached;
  const html = hljs.highlight(line, { language, ignoreIllegals: true }).value;
  const tokens = parseHljsHtml(html);
  lineCache.set(cacheKey, tokens);
  return tokens;
}

function parseHljsHtml(html: string): HighlightLine {
  const parser = new HljsHtmlParser(html);
  return parser.parseChildren(null);
}

class HljsHtmlParser {
  private pos = 0;
  constructor(private readonly source: string) {}

  parseChildren(closingTag: string | null): readonly HighlightTokenChild[] {
    const out: HighlightTokenChild[] = [];
    let textStart = this.pos;

    const flushText = (end: number): void => {
      if (end > textStart) {
        out.push(decodeEntities(this.source.slice(textStart, end)));
      }
    };

    while (this.pos < this.source.length) {
      const ch = this.source.charCodeAt(this.pos);
      if (ch !== 0x3c) {
        this.pos += 1;
        continue;
      }
      if (closingTag !== null && this.matchClosingTag(closingTag)) {
        flushText(this.pos);
        this.pos += closingTag.length + 3;
        return out;
      }
      const open = this.tryConsumeOpenSpan();
      if (open !== null) {
        flushText(open.tagStart);
        const children = this.parseChildren("span");
        out.push({ className: open.className, children });
        textStart = this.pos;
        continue;
      }
      this.pos += 1;
    }
    flushText(this.pos);
    return out;
  }

  private matchClosingTag(tag: string): boolean {
    const expected = `</${tag}>`;
    return this.source.startsWith(expected, this.pos);
  }

  private tryConsumeOpenSpan(): { className?: string; tagStart: number } | null {
    const tagStart = this.pos;
    if (!this.source.startsWith("<span", this.pos)) return null;
    const closeIdx = this.source.indexOf(">", this.pos);
    if (closeIdx < 0) return null;
    const inner = this.source.slice(this.pos + 5, closeIdx);
    const classMatch = /\sclass="([^"]*)"/.exec(inner);
    this.pos = closeIdx + 1;
    return { className: classMatch?.[1], tagStart };
  }
}

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
