import { expect, test } from "@playwright/test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  decodeWorkspaceFileLine,
  encodeWorkspaceFileLine,
  parseWorkspaceFileLine,
  remarkWorkspaceFileLines,
  workspaceFileLineFromAnchorProps,
} from "../../src/features/conversation/workspace-file-line";

const WORKSPACE = "/repo";

test("parseWorkspaceFileLine accepts the chosen spellings", () => {
  expect(parseWorkspaceFileLine("src/app.ts:298", WORKSPACE)).toEqual({
    path: "src/app.ts",
    line: 298,
    endLine: 298,
  });
  expect(parseWorkspaceFileLine("src/app.ts:10-20", WORKSPACE)).toEqual({
    path: "src/app.ts",
    line: 10,
    endLine: 20,
  });
  expect(parseWorkspaceFileLine("src/app.ts:10:4", WORKSPACE)).toEqual({
    path: "src/app.ts",
    line: 10,
    endLine: 10,
  });
  expect(parseWorkspaceFileLine("src/app.ts#L298", WORKSPACE)).toEqual({
    path: "src/app.ts",
    line: 298,
    endLine: 298,
  });
  expect(parseWorkspaceFileLine("README.md:4", WORKSPACE)).toEqual({
    path: "README.md",
    line: 4,
    endLine: 4,
  });
  expect(parseWorkspaceFileLine("./src/app.ts:8", WORKSPACE)?.path).toBe("src/app.ts");
  expect(parseWorkspaceFileLine("/repo/src/app.ts:298", WORKSPACE)).toEqual({
    path: "src/app.ts",
    line: 298,
    endLine: 298,
  });
  expect(parseWorkspaceFileLine("  src/app.ts:3  ", null)).toEqual({
    path: "src/app.ts",
    line: 3,
    endLine: 3,
  });
});

test("react-markdown passes file lines on the data attribute, not the href", () => {
  const file = { path: "src/app.ts", line: 3, endLine: 3 };
  const encoded = encodeWorkspaceFileLine(file);
  expect(workspaceFileLineFromAnchorProps({ "data-workspace-file-line": encoded })).toEqual(file);
  expect(workspaceFileLineFromAnchorProps({ href: "src/app.ts:3" })).toBeNull();
  expect(workspaceFileLineFromAnchorProps({ dataWorkspaceFileLine: encoded })).toEqual(file);
});

test("parseWorkspaceFileLine rejects web, mail, file, escape, and missing lines", () => {
  expect(parseWorkspaceFileLine("https://example.com/src/app.ts:298", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("http://example.com", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("mailto:test@example.com", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("file:///repo/src/app.ts:1", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("../secret.ts:3", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("src/../secret.ts:3", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("/other/src/app.ts:298", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("/repo-other/src/app.ts:1", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("/repo/src/app.ts:298", null)).toBeNull();
  expect(parseWorkspaceFileLine("src/app.ts", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("src/app.ts:0", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("src/app.ts:20-10", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("src/app.ts:08", WORKSPACE)).toBeNull();
  expect(parseWorkspaceFileLine("not a path", WORKSPACE)).toBeNull();
  expect(decodeWorkspaceFileLine("1:1:..%2Fsecret")).toBeNull();
});

test("assistant markdown links file lines and leaves fences and web links alone", () => {
  const text = [
    "See src/app.ts:298.",
    "Use `README.md:4` and [Implementation](src/app.ts#L298).",
    "Range `src/app.ts:10-20` and column src/app.ts:10:4.",
    "Absolute /repo/src/app.ts:298.",
    "Outside /other/src/app.ts:298 and ../secret.ts:3.",
    "Track [Docs](https://example.com/docs) and [email fallback](mailto:test@example.com).",
    "",
    "```",
    "src/app.ts:298",
    "```",
    "",
  ].join("\n");
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWorkspaceFileLines(WORKSPACE));
  const tree = processor.runSync(processor.parse(text));
  const files: Array<{ readonly label: string; readonly encoded: string }> = [];
  const fences: string[] = [];
  const webUrls: string[] = [];
  walkMarkdown(tree, (node) => {
    if (node.type === "code") {
      fences.push(node.value ?? "");
      expect(node.data?.hProperties?.dataWorkspaceFileLine).toBeUndefined();
      return;
    }
    const encoded = node.data?.hProperties?.dataWorkspaceFileLine;
    if (node.type === "link" && encoded) {
      files.push({ label: textOf(node), encoded });
    }
    if (node.type === "link" && !encoded && node.url) {
      webUrls.push(node.url);
    }
  });

  expect(files.map((file) => decodeWorkspaceFileLine(file.encoded))).toEqual([
    { path: "src/app.ts", line: 298, endLine: 298 },
    { path: "README.md", line: 4, endLine: 4 },
    { path: "src/app.ts", line: 298, endLine: 298 },
    { path: "src/app.ts", line: 10, endLine: 20 },
    { path: "src/app.ts", line: 10, endLine: 10 },
    { path: "src/app.ts", line: 298, endLine: 298 },
  ]);
  expect(files.map((file) => file.label)).toEqual([
    "src/app.ts:298",
    "README.md:4",
    "Implementation",
    "src/app.ts:10-20",
    "src/app.ts:10:4",
    "/repo/src/app.ts:298",
  ]);
  expect(webUrls).toEqual(["https://example.com/docs", "mailto:test@example.com"]);
  expect(fences.join("\n")).toContain("src/app.ts:298");
  expect(files.some((file) => file.label.includes("/other/") || file.label.includes(".."))).toBe(
    false,
  );
});

interface MarkdownWalkNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly children?: readonly MarkdownWalkNode[];
  readonly data?: { readonly hProperties?: { readonly dataWorkspaceFileLine?: string } };
}

function walkMarkdown(node: unknown, visit: (node: MarkdownWalkNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  const current = node as MarkdownWalkNode;
  visit(current);
  for (const child of current.children ?? []) {
    walkMarkdown(child, visit);
  }
}

function textOf(node: MarkdownWalkNode): string {
  if (typeof node.value === "string") {
    return node.value;
  }
  return (node.children ?? []).map((child) => textOf(child)).join("");
}
