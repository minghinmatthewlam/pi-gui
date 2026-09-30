/**
 * Reads and edits `mcpServers` in pi's `mcp.json` files: the global one in the agent directory and
 * a workspace's `.pi/mcp.json`. pi does not export its own editors, so `editMcpServers` mirrors
 * pi's (`dist/extensions/mcp/config.js`): change one server key, keep every other field and the
 * file's indentation, and refuse to overwrite a file that does not parse.
 *
 * Listings leave out `env`, `headers` and `oauth`, which can hold secrets.
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
  readonly enabled: boolean;
}

export interface McpServerListing {
  readonly servers: readonly McpServerSummary[];
  /** Files that could not be read, with why. */
  readonly errors: readonly string[];
}

export type NewMcpServer =
  | { readonly name: string; readonly command: string; readonly args?: readonly string[] }
  | { readonly name: string; readonly url: string };

export interface McpConfigLocation {
  readonly agentDir: string;
  readonly cwd: string;
}

/** pi's rule for server names (`validateMcpServerConfig` in pi's `core/mcp-servers.js`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME.test(name);
}

export function mcpConfigPath(location: McpConfigLocation, scope: McpServerScope): string {
  return scope === "global"
    ? join(location.agentDir, "mcp.json")
    : join(location.cwd, CONFIG_DIR_NAME, "mcp.json");
}

export function listMcpServers(location: McpConfigLocation): McpServerListing {
  const servers: McpServerSummary[] = [];
  const errors: string[] = [];
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
      if (summary) servers.push(summary);
      else errors.push(`${path}: MCP server "${name}" needs a "command" or a "url"`);
    }
  }
  return { servers, errors };
}

/** Adds a server to the global `mcp.json`, creating the file when missing. */
export function addMcpServer(agentDir: string, server: NewMcpServer): void {
  const name = server.name.trim();
  if (!isValidMcpServerName(name)) {
    throw new Error(`Invalid MCP server name "${name}" (use letters, digits, "_" and "-")`);
  }
  const config = newServerConfig(server);
  const path = join(agentDir, "mcp.json");
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

function newServerConfig(server: NewMcpServer): Record<string, unknown> {
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
  if (typeof value.command === "string" && value.command) {
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return { name, scope, transport: "stdio", command: value.command, args, enabled };
  }
  if (typeof value.url === "string" && value.url) {
    return { name, scope, transport: "http", url: withoutUserInfo(value.url), enabled };
  }
  return undefined;
}

/** Credentials in a URL's user info are as secret as a header. */
function withoutUserInfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
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
