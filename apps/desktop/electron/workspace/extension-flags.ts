import type { ExtensionFlagValues } from "@pi-gui/session-driver";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

export interface ResolvedExtensionFlags {
  /** Every registered flag the user set, switched-off booleans included: the workspace's next defaults. */
  readonly chosen: ExtensionFlagValues;
  /** What pi receives: `true` for switched-on booleans and non-empty text for value flags. */
  readonly applied: ExtensionFlagValues;
}

/**
 * Check a new thread's flag choices against the flags the workspace's enabled
 * extensions registered. Unknown names and wrong value types are dropped. A
 * boolean is sent only when on: pi switches a boolean flag on for any value it
 * receives, so a remembered `false` must never reach it.
 */
export function resolveExtensionFlags(
  requested: ExtensionFlagValues | undefined,
  runtime: RuntimeSnapshot | undefined,
): ResolvedExtensionFlags {
  const typeByName = new Map<string, "boolean" | "string">();
  for (const extension of runtime?.extensions ?? []) {
    if (!extension.enabled) continue;
    for (const flag of extension.flagDetails) typeByName.set(flag.name, flag.type);
  }
  const chosen: [string, boolean | string][] = [];
  const applied: [string, boolean | string][] = [];
  for (const [name, value] of Object.entries(requested ?? {})) {
    if (typeof value !== typeByName.get(name)) continue;
    chosen.push([name, value]);
    if (value === true) applied.push([name, true]);
    else if (typeof value === "string" && value.trim()) applied.push([name, value]);
  }
  return { chosen: Object.fromEntries(chosen), applied: Object.fromEntries(applied) };
}
