import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_PLUGINS } from "../../src/lib/markdown";
import { remarkWorkspaceFileLines } from "../../src/features/conversation/workspace-file-line";

function renderMarkdown(text: string, workspaceLinks = false): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: text,
      remarkPlugins: workspaceLinks
        ? [...MARKDOWN_PLUGINS, remarkWorkspaceFileLines("/repo")]
        : MARKDOWN_PLUGINS,
    }),
  );
}

for (const workspaceLinks of [false, true]) {
  test(`renders quoted Chinese strong text with workspace links ${workspaceLinks ? "enabled" : "disabled"}`, () => {
    const html = renderMarkdown(
      "真正的根治手段是**“避免在一个事务里锁整个宇宙”**。",
      workspaceLinks,
    );
    expect(html).toContain("是<strong>“避免在一个事务里锁整个宇宙”</strong>。");
    expect(html).not.toContain("**");
  });
}

test("recognizes emphasis beside CJK brackets and punctuation", () => {
  expect(renderMarkdown("前**「中文」**后，是*（重点）*。")).toContain(
    "前<strong>「中文」</strong>后，是<em>（重点）</em>。",
  );
  expect(renderMarkdown("これは**「重要」**です。")).toContain(
    "これは<strong>「重要」</strong>です。",
  );
  expect(renderMarkdown("이것은**“중요”**합니다.")).toContain(
    "이것은<strong>“중요”</strong>합니다.",
  );
});

test("keeps code and escaped emphasis literal", () => {
  const html = renderMarkdown(
    [
      "`是**“中文”**。`",
      "",
      "```text",
      "是**“中文”**。",
      "```",
      "",
      String.raw`是\*\*“中文”\*\*。`,
    ].join("\n"),
  );
  expect(html).toContain("<code>是**“中文”**。</code>");
  expect(html).toContain('<pre><code class="language-text">是**“中文”**。\n</code></pre>');
  expect(html).toContain("<p>是**“中文”**。</p>");
  expect(html).not.toContain("<strong>");
});

test("keeps incomplete streamed emphasis literal until its closing delimiter arrives", () => {
  expect(renderMarkdown("是**“中文")).toContain("<p>是**“中文</p>");
  expect(renderMarkdown("是**“中文”**。")).toContain("是<strong>“中文”</strong>。");
});

test("preserves ordinary GFM, English punctuation rules, and file links", () => {
  const html = renderMarkdown(
    [
      "**Strong** and *emphasis*, ~~deleted~~, [Docs](https://example.com).",
      "",
      "word**“quoted”**.",
      "",
      "See **src/app.ts:3**。",
      "",
      "| Key | Value |",
      "| --- | --- |",
      "| Status | Ready |",
    ].join("\n"),
    true,
  );
  expect(html).toContain("<strong>Strong</strong> and <em>emphasis</em>, <del>deleted</del>");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain("word**“quoted”**.");
  expect(html).toContain('data-workspace-file-line="3:3:src%2Fapp.ts"');
  expect(html).toContain("<table>");
});
