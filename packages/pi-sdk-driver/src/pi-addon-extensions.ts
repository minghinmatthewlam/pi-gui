import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

export interface PiAddonExtensionOptions {
  /** Opens an MCP server's sign-in page; pi opens the platform browser when omitted. */
  readonly openUrl?: (url: string) => void;
}

/**
 * pi's own add-ons, handed to pi the way its CLI does (`dist/extensions/index.js`), so pi loads
 * them as `builtin:<name>` and a `-builtin:<name>` `extensions` setting leaves one out. The names
 * must match pi's. Kept apart from pi-gui's own built-ins, whose gating drops these flags.
 */
const PI_ADDONS = [
  {
    name: "mcp",
    displayName: "MCP servers",
    description: "Connects the MCP servers in mcp.json and adds /mcp",
    create: (options: PiAddonExtensionOptions) =>
      createMcpExtension(options.openUrl ? { openUrl: options.openUrl } : {}),
  },
  {
    name: "codemode",
    displayName: "Code mode",
    description: "Lets the model run scripts that call tools, including MCP tools",
    create: () => createCodemodeExtension(),
  },
  {
    name: "tool-search",
    displayName: "Tool search",
    description: "Lets the model find and load tools on demand",
    create: () => createToolSearchExtension(),
  },
] as const;

export const PI_ADDON_EXTENSION_NAMES: readonly string[] = PI_ADDONS.map((addon) => addon.name);

export const BUILTIN_EXTENSION_PATH_PREFIX = "builtin:";

export function isBuiltinExtensionPath(path: string): boolean {
  return path.startsWith(BUILTIN_EXTENSION_PATH_PREFIX);
}

export function piAddonExtensions(options: PiAddonExtensionOptions = {}): InlineExtension[] {
  return PI_ADDONS.map((addon) => ({
    name: addon.name,
    factory: addon.create(options),
    builtin: true,
    replaceable: true,
  }));
}

/** Settings name and description for a `builtin:<name>` path of one of pi's add-ons. */
export function piAddonDisplay(
  path: string,
): { readonly displayName: string; readonly description: string } | undefined {
  const addon = PI_ADDONS.find((entry) => `${BUILTIN_EXTENSION_PATH_PREFIX}${entry.name}` === path);
  return addon && { displayName: addon.displayName, description: addon.description };
}
