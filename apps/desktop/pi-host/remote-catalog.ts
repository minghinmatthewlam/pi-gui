/**
 * Catalog storage across a pipe. The Rust core owns `catalogs.json`: the app reaches it with
 * `remoteCatalogStorage(core, coreMethods.catalogCall)`, and pi's driver in the host reaches
 * the app's copy of that client through `serveCatalogToPiHost`. Every hop uses the same
 * `{ path, args, undefinedAt }` call.
 */
import type { SessionFileCatalogStorage } from "@pi-gui/catalogs";
import {
  appMethods,
  decodeArgs,
  decodeResult,
  encodeArgs,
  encodeResult,
  type CatalogCallParams,
} from "./protocol";
import type { RpcPeer } from "../rpc/rpc-peer";

const CATALOG_GROUPS = {
  workspaces: ["listWorkspaces", "getWorkspace", "upsertWorkspace", "deleteWorkspace"],
  sessions: ["listSessions", "getSession", "upsertSession", "deleteSession"],
  worktrees: [
    "listWorktrees",
    "getWorktree",
    "upsertWorktree",
    "deleteWorktree",
    "replaceWorkspaceWorktrees",
  ],
} as const satisfies {
  readonly [
    G in "workspaces" | "sessions" | "worktrees"
  ]: readonly (keyof SessionFileCatalogStorage[G])[];
};

const SESSION_FILE_METHODS = [
  "getSessionFile",
  "setSessionFile",
  "deleteSessionFile",
  "replaceWorkspaceSessions",
] as const satisfies readonly (keyof SessionFileCatalogStorage)[];

const CATALOG_PATHS = new Set<string>([
  ...Object.entries(CATALOG_GROUPS).flatMap(([group, methods]) =>
    methods.map((method) => `${group}.${method}`),
  ),
  ...SESSION_FILE_METHODS,
]);

type AnyMethod = (...args: unknown[]) => unknown;

/** A catalog whose every call goes across `peer`: by default from the host to the app. */
export function remoteCatalogStorage(
  peer: RpcPeer,
  method: string = appMethods.catalog,
): SessionFileCatalogStorage {
  const call =
    (catalogPath: string): AnyMethod =>
    async (...args) =>
      decodeResult(await peer.request(method, { path: catalogPath, ...encodeArgs(args) }));
  const group = (name: keyof typeof CATALOG_GROUPS) =>
    Object.fromEntries(CATALOG_GROUPS[name].map((method) => [method, call(`${name}.${method}`)]));
  return {
    workspaces: group("workspaces"),
    sessions: group("sessions"),
    worktrees: group("worktrees"),
    ...Object.fromEntries(SESSION_FILE_METHODS.map((method) => [method, call(method)])),
  } as unknown as SessionFileCatalogStorage;
}

/** App side: answers the host's catalog calls from the app's own catalog. */
export function serveCatalogToPiHost(peer: RpcPeer, storage: SessionFileCatalogStorage): void {
  peer.handle(appMethods.catalog, async (params) => {
    const { path, ...encoded } = params as CatalogCallParams;
    if (!CATALOG_PATHS.has(path)) throw new Error(`Unknown catalog method: ${path}`);
    const [first, second] = path.split(".");
    const target = (second === undefined
      ? storage
      : (storage as unknown as Record<string, Record<string, AnyMethod>>)[
          first!
        ]) as unknown as Record<string, AnyMethod>;
    const method = target[second ?? first!]!;
    return encodeResult(await method.apply(target, decodeArgs(encoded)));
  });
}
