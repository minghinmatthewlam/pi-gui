/**
 * Reads and edits `mcpServers` in pi's `mcp.json` files: the global one in the agent directory and
 * a workspace's `.pi/mcp.json`. pi does not export its own editors, so `editMcpServers` mirrors
 * pi's (`dist/extensions/mcp/config.js`): change one server key, keep every other field and the
 * file's indentation, and refuse to overwrite a file that does not parse.
 *
 * Listings leave out `env`, `headers` and `oauth`, which can hold secrets, and say only whether a
 * server has any; URLs are listed without user info, query or fragment, and arguments that look
 * like credentials are masked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type McpServerScope = "global" | "project";

export interface McpServerSummary {
  readonly name: string;
  readonly scope: McpServerScope;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  /** What the server offers, in a sentence; pi shows it to the model with the server. */
  readonly description?: string;
  readonly enabled: boolean;
  /** The entry has environment variables, headers or sign-in config, which are never listed. */
  readonly hasHiddenSettings: boolean;
}

export interface McpServerListing {
  /** The global `mcp.json`, where new servers go. */
  readonly globalConfigPath: string;
  readonly servers: readonly McpServerSummary[];
  /** Files that could not be read, and servers pi skips, with why. */
  readonly errors: readonly string[];
}

export type NewMcpServer = { readonly name: string; readonly description?: string } & (
  { readonly command: string; readonly args?: readonly string[] } | { readonly url: string }
);

export interface McpConfigLocation {
  readonly agentDir: string;
  readonly cwd: string;
}

/** pi's rule for server names (`validateMcpServerConfig` in pi's `core/mcp-servers.js`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME.test(name);
}

/**
 * pi's `mcpNamespace` (`core/mcp-servers.js`, not exported): tool names replace `-` with `_`, so
 * two names that differ only there share a namespace and pi skips the second one it reads.
 */
function mcpNamespace(name: string): string {
  return `mcp__${name.replaceAll("-", "_")}`;
}

export function mcpConfigPath(location: McpConfigLocation, scope: McpServerScope): string {
  return scope === "global"
    ? join(location.agentDir, "mcp.json")
    : join(location.cwd, CONFIG_DIR_NAME, "mcp.json");
}

export function listMcpServers(location: McpConfigLocation): McpServerListing {
  const servers: McpServerSummary[] = [];
  const errors: string[] = [];
  // pi reads the global file first; a later name in either file that shares a namespace
  // with an earlier one is skipped (the same name in the project file overrides instead).
  const seen: string[] = [];
  for (const scope of ["global", "project"] as const) {
    const path = mcpConfigPath(location, scope);
    let entries: Record<string, unknown> | undefined;
    try {
      entries = readMcpServers(path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const [name, value] of Object.entries(entries ?? {})) {
      const summary = summarizeServer(name, scope, value);
      if (!summary) {
        errors.push(`${path}: MCP server "${name}" needs a "command" or a "url"`);
        continue;
      }
      servers.push(summary);
      const clash = namespaceClash(seen, name);
      if (clash) {
        errors.push(
          `${path}: pi skips MCP server "${name}" because its name clashes with "${clash}"`,
        );
        continue;
      }
      if (scope === "project" && summary.transport === "http" && isRecord(value) && value.auth) {
        errors.push(
          `${path}: pi skips MCP server "${name}" because "auth" is only allowed in the global mcp.json`,
        );
        continue;
      }
      if (!seen.includes(name)) seen.push(name);
    }
  }
  return { globalConfigPath: mcpConfigPath(location, "global"), servers, errors };
}

/** Adds a server to the global `mcp.json`, creating the file when missing. */
export function addMcpServer(location: McpConfigLocation, server: NewMcpServer): void {
  const name = server.name.trim();
  if (!isValidMcpServerName(name)) {
    throw new Error(`Invalid MCP server name "${name}" (use letters, digits, "_" and "-")`);
  }
  const config = newServerConfig(server);
  // The project file is read only for its names: a clash there would make pi skip one server.
  for (const scope of ["global", "project"] as const) {
    let existing: Record<string, unknown> | undefined;
    try {
      existing = readMcpServers(mcpConfigPath(location, scope));
    } catch {
      continue; // The global file is checked again below; an unreadable project file is skipped by pi too.
    }
    const clash = namespaceClash(Object.keys(existing ?? {}), name);
    if (clash) {
      throw new Error(
        `An MCP server named "${clash}" already exists, and pi treats "-" and "_" in names as the same`,
      );
    }
  }
  const path = mcpConfigPath(location, "global");
  editMcpServers(path, (servers, parsed) => {
    const target = servers ?? {};
    if (Object.hasOwn(target, name)) {
      throw new Error(`An MCP server named "${name}" already exists`);
    }
    // Defined, not assigned, so a name like "__proto__" is saved as a key.
    Object.defineProperty(target, name, {
      value: config,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    parsed.mcpServers = target;
    return true;
  });
}

/** Removes a server from the global `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServer(agentDir: string, name: string): boolean {
  const path = join(agentDir, "mcp.json");
  if (!existsSync(path)) return false;
  let removed = false;
  editMcpServers(path, (servers) => {
    if (!servers || !Object.hasOwn(servers, name)) return false;
    delete servers[name];
    removed = true;
    return true;
  });
  return removed;
}

/** Writes `enabled: false`, or deletes `enabled` to switch a server back on, as pi's `/mcp` does. */
export function setMcpServerEnabled(
  location: McpConfigLocation,
  scope: McpServerScope,
  name: string,
  enabled: boolean,
): void {
  const path = mcpConfigPath(location, scope);
  editMcpServers(path, (servers) => {
    const server = servers && Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
    if (enabled) delete server.enabled;
    else server.enabled = false;
    return true;
  });
}

/** An earlier name, other than `name` itself, that shares `name`'s namespace. */
function namespaceClash(names: readonly string[], name: string): string | undefined {
  return names.find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
}

function newServerConfig(server: NewMcpServer): Record<string, unknown> {
  const description = server.description?.trim();
  return description ? { ...transportConfig(server), description } : transportConfig(server);
}

function transportConfig(server: NewMcpServer): Record<string, unknown> {
  if ("url" in server) {
    const url = server.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("MCP server URL must be a valid http:// or https:// URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MCP server URL must be a valid http:// or https:// URL");
    }
    return { url };
  }
  const command = server.command.trim();
  if (!command) throw new Error("MCP server command must not be empty");
  const args = server.args ?? [];
  return args.length > 0 ? { command, args: [...args] } : { command };
}

function summarizeServer(
  name: string,
  scope: McpServerScope,
  value: unknown,
): McpServerSummary | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = value.enabled !== false;
  const hasHiddenSettings = HIDDEN_FIELDS.some((field) => hasContent(value[field]));
  const description =
    typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {};
  if (typeof value.command === "string" && value.command) {
    const args = Array.isArray(value.args)
      ? redactArgs(value.args.filter((arg): arg is string => typeof arg === "string"))
      : [];
    return {
      name,
      scope,
      transport: "stdio",
      command: value.command,
      args,
      ...description,
      enabled,
      hasHiddenSettings,
    };
  }
  if (typeof value.url === "string" && value.url) {
    const url = redactUrl(value.url);
    return { name, scope, transport: "http", url, ...description, enabled, hasHiddenSettings };
  }
  return undefined;
}

const HIDDEN_FIELDS = ["env", "headers", "oauth", "auth"] as const;

/** Names that usually hold a credential, in a flag (`--api-key`) or a `NAME=value` pair. */
const SECRET_NAME = /token|key|secret|password|passwd|auth|credential|bearer/i;
const HTTP_URL = /^https?:\/\//i;
const MASK = "•••";

/**
 * Masks likely credentials in stdio arguments: the value of `NAME=value`, `--flag=value` or
 * `Name: value` when the name looks secret, and the argument after such a flag (unless that
 * is another `--flag`). Errs toward masking; the file itself is unchanged.
 */
function redactArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext && !arg.startsWith("--")) {
      redacted.push(MASK);
      maskNext = false;
      continue;
    }
    maskNext = false;
    // Server URLs passed as arguments (`mcp-remote https://…?api_key=…`) leak like the `url` field.
    if (HTTP_URL.test(arg)) {
      redacted.push(redactUrl(arg));
      continue;
    }
    const pair = /^([^=:\s]+)(=|:\s*)/.exec(arg);
    if (pair) {
      const value = arg.slice(pair[0].length);
      redacted.push(
        SECRET_NAME.test(pair[1]!)
          ? `${pair[1]}${pair[2]}${MASK}`
          : HTTP_URL.test(value)
            ? `${pair[1]}${pair[2]}${redactUrl(value)}`
            : arg,
      );
      continue;
    }
    redacted.push(arg);
    maskNext = arg.startsWith("-") && SECRET_NAME.test(arg);
  }
  return redacted;
}

function hasContent(value: unknown): boolean {
  return (
    value !== undefined && value !== null && !(isRecord(value) && Object.keys(value).length === 0)
  );
}

/**
 * User info, query and fragment can carry credentials (`?api_key=…`), so they are dropped;
 * a trailing `?…` says something was left out.
 */
function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Nothing tells the secret parts apart; pi refuses this entry anyway.
    return "(invalid URL)";
  }
  const hasUserInfo = parsed.username !== "" || parsed.password !== "";
  const hasQuery = parsed.search !== "" || parsed.hash !== "";
  if (!hasUserInfo && !hasQuery) return url;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return hasQuery ? `${parsed.toString()}?…` : parsed.toString();
}

function readMcpServers(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = parseMcpFile(path, readFileSync(path, "utf8"));
  return isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
}

function parseMcpFile(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${path}: expected an object with an "mcpServers" object`);
  }
  return parsed;
}

/**
 * Reads an `mcp.json` (empty when missing), lets `edit` change its `mcpServers`, and writes it back
 * with its indentation when `edit` returns true. Other content is kept.
 */
function editMcpServers(
  path: string,
  edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const parsed = text === undefined ? {} : parseMcpFile(path, text);
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
  if (!edit(servers, parsed)) return;
  const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
