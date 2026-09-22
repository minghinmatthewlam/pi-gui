import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadedDesktopExtensionSource {
  readonly resolvedPath: string;
}

export interface DesktopExtensionSourceIdentity {
  readonly extensionId: string;
  readonly sourcePath: string;
}

export interface ValidatedDesktopExtensionSource extends DesktopExtensionSourceIdentity {
  readonly frontendPath: string;
  readonly assetRoot: string;
}

function localFilePath(value: string | URL, label: string): string {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "file:" || url.search || url.hash) {
    throw new Error(`${label} must be a local file URL without a query or fragment`);
  }
  return fileURLToPath(url);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Match a declaration to Pi's selected extension; never load another backend entry. */
export async function validateDesktopExtensionSource(
  declaration: { readonly source: string; readonly frontend: string | URL },
  loadedExtensions: readonly LoadedDesktopExtensionSource[],
): Promise<ValidatedDesktopExtensionSource> {
  const identity = await validateDesktopExtensionIdentity(declaration.source, loadedExtensions);
  return validateDesktopExtensionFrontend(identity, declaration.frontend);
}

export async function validateDesktopExtensionIdentity(
  source: string,
  loadedExtensions: readonly LoadedDesktopExtensionSource[],
): Promise<DesktopExtensionSourceIdentity> {
  const sourcePath = await realpath(localFilePath(source, "Extension source"));
  const matches = await Promise.all(
    loadedExtensions.map(async ({ resolvedPath }) => {
      // Inline factories have no file-based asset authority.
      if (!path.isAbsolute(resolvedPath)) return false;
      try {
        return (await realpath(resolvedPath)) === sourcePath;
      } catch {
        return false;
      }
    }),
  );
  if (matches.filter(Boolean).length !== 1) {
    throw new Error("Desktop view source must match exactly one loaded Pi extension");
  }
  if (!(await stat(sourcePath)).isFile()) {
    throw new Error("Desktop view source must be an extension entry file");
  }
  return {
    extensionId: createHash("sha256").update(sourcePath).digest("hex").slice(0, 24),
    sourcePath,
  };
}

export async function validateDesktopExtensionFrontend(
  identity: DesktopExtensionSourceIdentity,
  frontend: string | URL,
): Promise<ValidatedDesktopExtensionSource> {
  const frontendPath = await realpath(localFilePath(frontend, "Desktop frontend"));
  if (!isPathWithin(path.dirname(identity.sourcePath), frontendPath)) {
    throw new Error("Desktop frontend must stay inside its loaded extension directory");
  }
  if (
    !(await stat(frontendPath)).isFile() ||
    ![".js", ".mjs"].includes(path.extname(frontendPath))
  ) {
    throw new Error("Desktop frontend must be a prebuilt JavaScript module");
  }
  return {
    ...identity,
    frontendPath,
    // Serve the browser build only, not all the extension's source files.
    assetRoot: path.dirname(frontendPath),
  };
}

/** Resolve every requested asset after decoding; symlinks cannot widen its authority. */
export async function resolveDesktopExtensionAsset(
  assetRoot: string,
  encodedPath: string,
): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("Malformed desktop asset path");
  }
  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("Desktop asset path is outside its browser build");
  }
  const candidate = path.resolve(assetRoot, decoded);
  if (!isPathWithin(assetRoot, candidate)) {
    throw new Error("Desktop asset path is outside its browser build");
  }
  const resolved = await realpath(candidate);
  if (!isPathWithin(assetRoot, resolved) || !(await stat(resolved)).isFile()) {
    throw new Error("Desktop asset path is outside its browser build");
  }
  return resolved;
}
