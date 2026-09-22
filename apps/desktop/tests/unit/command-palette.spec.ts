import { expect, test } from "@playwright/test";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  isPaletteCommand,
} from "../../contracts/ipc";
import {
  fuzzyMatch,
  normalizeQuery,
  rankByFuzzy,
  rankPaths,
} from "../../src/features/command-palette/fuzzy-match";
import {
  buildCommandSections,
  buildFileSections,
  type PaletteCandidate,
} from "../../src/features/command-palette/palette-sections";

function candidate(id: string, title: string): PaletteCandidate {
  return { id, title, icon: null, run: () => undefined };
}

function titles(sections: ReturnType<typeof buildCommandSections>) {
  return sections.map((section) => [section.label, section.items.map((item) => item.title)]);
}

test("maps Cmd/Ctrl+K and Cmd/Ctrl+P to the palettes", () => {
  expect(getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "k" })).toBe(
    desktopCommands.openCommandPalette,
  );
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "π", code: "KeyP" }),
  ).toBe(desktopCommands.openFilePalette);
  expect(getDesktopCommandFromShortcut({ modifier: true, shift: true, key: "K" })).toBeUndefined();
  expect(
    getDesktopCommandFromShortcut({ modifier: false, shift: false, key: "p" }),
  ).toBeUndefined();
  expect(
    getDesktopCommandFromShortcut({ modifier: true, shift: false, key: "Tab", code: "Tab" }),
  ).toBeUndefined();
  expect(isPaletteCommand(desktopCommands.openFilePalette)).toBe(true);
  expect(isPaletteCommand(desktopCommands.toggleTerminal)).toBe(false);
});

test("fuzzy match requires every query character in order", () => {
  expect(fuzzyMatch("abc", "a-b-c")?.positions).toEqual([0, 2, 4]);
  expect(fuzzyMatch("acb", "abc")).toBeNull();
  expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  expect(normalizeQuery(" App TSX ")).toBe("apptsx");
});

test("fuzzy match prefers word starts and consecutive runs", () => {
  // "fb" should land on the word starts of "Foo Bar", not the "b" in "foob".
  expect(fuzzyMatch("fb", "foob Bar")?.positions).toEqual([0, 5]);
  const wordStart = fuzzyMatch("set", "Open settings");
  const scattered = fuzzyMatch("set", "Some extra text");
  expect(wordStart && scattered && wordStart.score > scattered.score).toBe(true);
});

test("ranks titles by match quality", () => {
  const ranked = rankByFuzzy(
    ["Refactor settings view", "Fix login bug", "Settings sync"],
    "settings",
    (title) => title,
  );
  expect(ranked.map((entry) => entry.item)).toEqual(["Settings sync", "Refactor settings view"]);
});

test("ranks file names above scattered directory matches", () => {
  const paths = [
    "src/app/app-shell-utils.ts",
    "src/app/App.tsx",
    "apps/desktop/package.json",
    "docs/architecture.md",
  ];
  const ranked = rankPaths(paths, "app.tsx", 10);
  expect(ranked[0]?.item).toBe("src/app/App.tsx");
  // Positions index the full path and cover the file name.
  expect(ranked[0]?.match.positions).toEqual([8, 9, 10, 11, 12, 13, 14]);
  expect(rankPaths(paths, "zzz", 10)).toEqual([]);
  expect(rankPaths(paths, "", 2).map((entry) => entry.item)).toEqual(paths.slice(0, 2));
});

test("command palette shows recents and actions until a query", () => {
  const chats = ["One", "Two", "Three", "Four", "Five", "Six"].map((title) =>
    candidate(`chat:${title}`, title),
  );
  const workspaces = [candidate("workspace:pi", "pi-gui")];
  const actions = [candidate("action:settings", "Settings"), candidate("action:new", "New thread")];

  expect(
    titles(buildCommandSections({ query: "", filter: "all", chats, workspaces, actions })),
  ).toEqual([
    ["Recents", ["One", "Two", "Three", "Four", "Five"]],
    ["Actions", ["Settings", "New thread"]],
  ]);
  expect(
    titles(buildCommandSections({ query: "", filter: "workspaces", chats, workspaces, actions })),
  ).toEqual([["Workspaces", ["pi-gui"]]]);
});

test("a query puts the strongest kind first and drops empty kinds", () => {
  const chats = [candidate("chat:a", "Renew the thread pool")];
  const workspaces = [candidate("workspace:pi", "pi-gui")];
  const actions = [candidate("action:new", "New thread")];
  const sections = buildCommandSections({
    query: "new thread",
    filter: "all",
    chats,
    workspaces,
    actions,
  });
  expect(sections.map((section) => section.label)).toEqual(["Actions", "Chats"]);
  expect(sections[0]?.items[0]?.titleMatches).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);

  expect(
    buildCommandSections({ query: "new", filter: "workspaces", chats, workspaces, actions }),
  ).toEqual([]);
});

test("file palette lists open tabs until a query, then splits name and directory", () => {
  const toCandidate = (path: string) => candidate(`file:${path}`, path.split("/").at(-1) ?? path);
  const openTabs = ["README.md", "src/app/App.tsx"];
  expect(
    buildFileSections({ query: "", files: [], openTabs, toCandidate })[0]?.items.map(
      (item) => item.id,
    ),
  ).toEqual(["file:src/app/App.tsx", "file:README.md"]);

  const [section] = buildFileSections({
    query: "srcapp",
    files: ["src/app/App.tsx"],
    openTabs,
    toCandidate,
  });
  const [item] = section?.items ?? [];
  expect(item?.detailMatches).toEqual([0, 1, 2, 4, 5, 6]);
  expect(item?.titleMatches).toEqual([]);
});
