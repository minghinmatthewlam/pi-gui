import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
  resolveDesktopExtensionAsset,
  validateDesktopExtensionSource,
} from "../../electron/extensions/extension-view-source";

test("desktop assets belong to one loaded extension and its browser build", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-source-"));
  try {
    const source = path.join(directory, "extension.ts");
    const build = path.join(directory, "dist");
    const frontend = path.join(build, "desktop.js");
    await mkdir(build);
    await writeFile(source, "export default () => {};");
    await writeFile(frontend, "export const mount = () => () => {};");
    const declaration = { source: pathToFileURL(source).href, frontend: pathToFileURL(frontend) };
    const validated = await validateDesktopExtensionSource(declaration, [{ resolvedPath: source }]);
    expect(validated.assetRoot).toBe(await realpath(build));
    expect(validated.extensionId).toMatch(/^[0-9a-f]{24}$/);
    expect(await resolveDesktopExtensionAsset(validated.assetRoot, "desktop.js")).toBe(
      await realpath(frontend),
    );
    await expect(validateDesktopExtensionSource(declaration, [])).rejects.toThrow("exactly one");
    await expect(
      validateDesktopExtensionSource(declaration, [
        { resolvedPath: source },
        { resolvedPath: source },
      ]),
    ).rejects.toThrow("exactly one");
    await expect(
      validateDesktopExtensionSource(
        { ...declaration, frontend: "https://example.com/desktop.js" },
        [{ resolvedPath: source }],
      ),
    ).rejects.toThrow("local file URL");
    await expect(resolveDesktopExtensionAsset(build, "../extension.ts")).rejects.toThrow("outside");
    await expect(resolveDesktopExtensionAsset(build, "%2e%2e/extension.ts")).rejects.toThrow(
      "outside",
    );
    await expect(resolveDesktopExtensionAsset(build, "..%5cextension.ts")).rejects.toThrow(
      "outside",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop asset validation rejects symlink escapes at registration and serving", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-escape-"));
  try {
    const extension = path.join(directory, "extension");
    const build = path.join(extension, "dist");
    const source = path.join(extension, "index.ts");
    const outside = path.join(directory, "secret.js");
    await mkdir(build, { recursive: true });
    await writeFile(source, "export default () => {};");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(build, "escape.js"));
    await expect(
      validateDesktopExtensionSource(
        {
          source: pathToFileURL(source).href,
          frontend: pathToFileURL(path.join(build, "escape.js")),
        },
        [{ resolvedPath: source }],
      ),
    ).rejects.toThrow("inside its loaded extension");
    await expect(resolveDesktopExtensionAsset(build, "escape.js")).rejects.toThrow("outside");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
