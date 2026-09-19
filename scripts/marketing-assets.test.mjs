import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

test("every published marketing asset has one runnable producer and live consumers", async () => {
  const manifest = await readJson("scripts/marketing-assets.json");
  const rootPackage = await readJson("package.json");
  const seenPaths = new Set();

  for (const asset of manifest.assets) {
    assert.equal(seenPaths.has(asset.path), false, `duplicate asset mapping: ${asset.path}`);
    seenPaths.add(asset.path);
    assert.equal(
      typeof rootPackage.scripts[asset.producer],
      "string",
      `${asset.path} names missing root script ${asset.producer}`,
    );

    for (const consumer of asset.consumers) {
      const source = await readFile(path.join(root, consumer.path), "utf8");
      assert.match(
        source,
        new RegExp(consumer.reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${consumer.path} no longer consumes ${asset.path}`,
      );
    }
  }
});

test("product build excludes media rendering and marketing commands are explicit", async () => {
  const rootPackage = await readJson("package.json");
  assert.match(rootPackage.scripts.build, /--filter @pi-gui\/desktop run build/);
  assert.match(rootPackage.scripts.build, /--filter @pi-gui\/website run build/);
  assert.doesNotMatch(rootPackage.scripts.build, /video|render|recursive| -r(?:\s|$)/);
  assert.match(rootPackage.scripts["marketing:render"], /@pi-app\/video run render/);
});

test("marketing commands delegate to scripts owned by their producer workspace", async () => {
  const rootPackage = await readJson("package.json");
  const desktopPackage = await readJson("apps/desktop/package.json");
  const videoPackage = await readJson("video/package.json");
  const delegations = [
    ["marketing:demo", rootPackage.scripts["marketing:demo"], desktopPackage, "demo:readme"],
    [
      "marketing:capture",
      rootPackage.scripts["marketing:capture"],
      desktopPackage,
      "demo:showcase-captures",
    ],
    ["marketing:render", rootPackage.scripts["marketing:render"], videoPackage, "render"],
  ];

  for (const [producer, command, ownerPackage, ownerScript] of delegations) {
    assert.match(command, new RegExp(` run ${ownerScript.replace(":", "\\:")}(?:$|\\s)`));
    assert.equal(
      typeof ownerPackage.scripts[ownerScript],
      "string",
      `${producer} delegates to missing owner script ${ownerScript}`,
    );
  }
});

test("the demo producer supports safe staged proof without real credentials or cleanup", async () => {
  const source = await readFile(path.join(root, "apps/desktop/scripts/readme-demo.mts"), "utf8");
  assert.match(source, /PI_GUI_MARKETING_STAGE_DIR/);
  assert.doesNotMatch(source, /\brm\(/);
  assert.match(source, /scrubProviderEnv: true/);
  assert.doesNotMatch(source, /realAuthSourceDir/);

  const showcaseSource = await readFile(
    path.join(root, "apps/desktop/scripts/capture-showcase.mts"),
    "utf8",
  );
  assert.match(showcaseSource, /PI_GUI_MARKETING_STAGE_DIR/);
  assert.match(showcaseSource, /PI_GUI_MARKETING_ALLOW_PROVIDER_ENV/);
  assert.match(showcaseSource, /PI_GUI_MARKETING_PROVIDER/);
  assert.match(showcaseSource, /PI_GUI_MARKETING_MODEL/);
  assert.match(showcaseSource, /"auth\.json"\), "\{\}\\n"/);
  assert.doesNotMatch(showcaseSource, /realAuthSourceDir/);
  assert.doesNotMatch(showcaseSource, /\brm\(/);
});

test("failed media generation preserves the published file and partial evidence", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(path.join(root, "scripts/marketing-output-test.cjs"));
  const { replaceFileAtomically } = await jiti.import(
    path.join(root, "apps/desktop/scripts/atomic-output.mts"),
  );
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "pi-gui-marketing-output-"));
  const outputPath = path.join(fixtureDir, "published.mp4");
  await writeFile(outputPath, "existing published media");

  await assert.rejects(
    replaceFileAtomically(outputPath, async (temporaryOutputPath) => {
      await writeFile(temporaryOutputPath, "partial failed media");
      throw new Error("simulated encoder failure");
    }),
    /simulated encoder failure/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "existing published media");
  assert.ok(
    (await readdir(fixtureDir)).some((entry) => entry.includes(".partial-")),
    "failed output should remain available as evidence",
  );

  await replaceFileAtomically(outputPath, (temporaryOutputPath) =>
    writeFile(temporaryOutputPath, "complete new media"),
  );
  assert.equal(await readFile(outputPath, "utf8"), "complete new media");
});
