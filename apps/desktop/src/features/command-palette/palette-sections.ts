import type { PaletteFilter, PaletteItem, PaletteSection } from "./command-palette";
import { rankByFuzzy, rankPaths } from "./fuzzy-match";

/** An item before matching; the palette highlights its title. */
export type PaletteCandidate = Omit<PaletteItem, "titleMatches" | "detailMatches">;

export type CommandFilter = "all" | "chats" | "workspaces" | "actions";

export const COMMAND_FILTERS: readonly PaletteFilter<CommandFilter>[] = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "workspaces", label: "Workspaces" },
  { id: "actions", label: "Actions" },
];

const RECENT_CHAT_COUNT = 5;
const ALL_FILTER_LIMITS = { chats: 8, workspaces: 5, actions: 8 } as const;
const SINGLE_FILTER_LIMIT = 100;
export const FILE_RESULT_LIMIT = 60;

function rankedSection(
  id: string,
  label: string,
  candidates: readonly PaletteCandidate[],
  query: string,
  limit: number,
): { readonly section: PaletteSection; readonly topScore: number } {
  const ranked = rankByFuzzy(candidates, query, (candidate) => candidate.title, limit);
  return {
    section: {
      id,
      label,
      items: ranked.map(({ item, match }) => ({ ...item, titleMatches: match.positions })),
    },
    topScore: ranked[0]?.match.score ?? Number.NEGATIVE_INFINITY,
  };
}

/**
 * Cmd-K results. With no query, All shows recent chats then every action; a
 * single filter lists its kind. A query ranks each kind by title, and All puts
 * the kind with the strongest match first.
 */
export function buildCommandSections(input: {
  readonly query: string;
  readonly filter: CommandFilter;
  /** Most recently used first. */
  readonly chats: readonly PaletteCandidate[];
  readonly workspaces: readonly PaletteCandidate[];
  readonly actions: readonly PaletteCandidate[];
}): readonly PaletteSection[] {
  const { query, filter, chats, workspaces, actions } = input;
  if (query.trim() === "") {
    switch (filter) {
      case "chats":
        return [{ id: "chats", label: "Chats", items: chats.slice(0, SINGLE_FILTER_LIMIT) }];
      case "workspaces":
        return [{ id: "workspaces", label: "Workspaces", items: workspaces }];
      case "actions":
        return [{ id: "actions", label: "Actions", items: actions }];
      case "all":
        return [
          { id: "recents", label: "Recents", items: chats.slice(0, RECENT_CHAT_COUNT) },
          { id: "actions", label: "Actions", items: actions },
        ];
    }
  }

  const single = filter !== "all";
  const kinds = [
    { id: "chats", label: "Chats", candidates: chats },
    { id: "workspaces", label: "Workspaces", candidates: workspaces },
    { id: "actions", label: "Actions", candidates: actions },
  ] as const;
  return kinds
    .filter((kind) => !single || kind.id === filter)
    .map((kind) =>
      rankedSection(
        kind.id,
        kind.label,
        kind.candidates,
        query,
        single ? SINGLE_FILTER_LIMIT : ALL_FILTER_LIMITS[kind.id],
      ),
    )
    .filter((ranked) => ranked.section.items.length > 0)
    .sort((left, right) => right.topScore - left.topScore)
    .map((ranked) => ranked.section);
}

export function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, directory: "" }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

/**
 * Cmd-P results. With no query, the thread's open file tabs, newest first.
 * A query ranks every listed path and highlights the name and directory.
 */
export function buildFileSections(input: {
  readonly query: string;
  readonly files: readonly string[];
  readonly openTabs: readonly string[];
  readonly toCandidate: (path: string) => PaletteCandidate;
}): readonly PaletteSection[] {
  const { query, files, openTabs, toCandidate } = input;
  if (query.trim() === "") {
    return [
      {
        id: "open-files",
        label: "Open files",
        items: [...openTabs].reverse().map(toCandidate),
      },
    ];
  }
  const items = rankPaths(files, query, FILE_RESULT_LIMIT).map(({ item: path, match }) => {
    const { directory } = splitPath(path);
    const nameStart = directory ? directory.length + 1 : 0;
    return {
      ...toCandidate(path),
      titleMatches: match.positions
        .filter((position) => position >= nameStart)
        .map((position) => position - nameStart),
      detailMatches: match.positions.filter((position) => position < directory.length),
    };
  });
  return [{ id: "files", label: "Files", items }];
}

export function buildListSection(input: {
  readonly id: string;
  readonly label: string;
  readonly query: string;
  readonly candidates: readonly PaletteCandidate[];
}): readonly PaletteSection[] {
  if (input.query.trim() === "") {
    return [{ id: input.id, label: input.label, items: input.candidates }];
  }
  return [
    rankedSection(input.id, input.label, input.candidates, input.query, SINGLE_FILTER_LIMIT)
      .section,
  ];
}
