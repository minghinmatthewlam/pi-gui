import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

/** A pi-gui-owned pi extension that users can switch off in Settings. */
export interface BuiltinExtension {
  /** Stable id; pi reports the loaded extension at `<inline:name>`. */
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly factory: ExtensionFactory;
}

export type BuiltinExtensionEnabled = (name: string) => boolean;

export function builtinExtensionPath(name: string): string {
  return `<inline:${name}>`;
}

export function findBuiltinExtension(
  builtins: readonly BuiltinExtension[],
  path: string,
): BuiltinExtension | undefined {
  return builtins.find((builtin) => builtinExtensionPath(builtin.name) === path);
}

/**
 * Pi runs inline factories again on every reload, so checking the preference inside the factory
 * lets an open session drop or regain a built-in's tools on its next reload.
 */
export function gatedBuiltinExtensions(
  builtins: readonly BuiltinExtension[],
  isEnabled: BuiltinExtensionEnabled,
): InlineExtension[] {
  return builtins.map((builtin) => ({
    name: builtin.name,
    factory: (pi) => (isEnabled(builtin.name) ? builtin.factory(pi) : undefined),
  }));
}
