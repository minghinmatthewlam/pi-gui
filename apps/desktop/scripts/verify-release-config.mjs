import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { DebugLogger } from "builder-util";
import { parseDocument } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..", "..", "..");
const linuxPackageCommand = "electron-builder --linux --publish never";
const linuxDependencies = [
  "libgtk-3-0 | libgtk-3-0t64",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libuuid1",
  "libsecret-1-0",
  "libgbm1",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseYaml(relativePath) {
  const filePath = path.join(repoDir, relativePath);
  const document = parseDocument(await readFile(filePath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function stepNamed(job, name) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step "${name}"`);
  return step;
}

function runText(step) {
  return typeof step.run === "string" ? step.run : "";
}

function validateCiWorkflow(workflow) {
  const versionCheck = stepNamed(
    workflow.jobs?.typecheck,
    "Verify release version consistency",
  );
  assert(
    runText(versionCheck).includes("pnpm verify:release-version"),
    "CI must reject drift between product package versions",
  );

  const linuxJob = workflow.jobs?.["desktop-package-linux"];
  assert(linuxJob?.["runs-on"] === "ubuntu-latest", "Linux package CI must run on Ubuntu");
  assert(
    runText(stepNamed(linuxJob, "Verify Linux package configuration")).includes(
      "verify:release-config",
    ),
    "Linux package CI must validate release configuration before packaging",
  );
  assert(
    runText(stepNamed(linuxJob, "Package Linux AppImage and deb")).includes(
      "run package:linux",
    ),
    "Linux package CI must build the configured AppImage and deb targets",
  );
  assert(
    runText(stepNamed(linuxJob, "Verify Linux packages")).includes(
      "verify-linux-release.sh",
    ) &&
      runText(stepNamed(linuxJob, "Verify Linux packages")).includes("--install"),
    "Linux package CI must run native archive and install lifecycle verification",
  );

  const packageVerification = stepNamed(linuxJob, "Verify Linux packages");
  const candidateStage = stepNamed(linuxJob, "Stage validated Linux candidate");
  assert(
    runText(candidateStage).includes("release-artifacts.mjs stage"),
    "Linux package CI must validate actual outputs through the candidate manifest helper",
  );

  const candidateUpload = stepNamed(linuxJob, "Upload immutable Linux CI candidate");
  assert(
    candidateUpload.uses === "actions/upload-artifact@v4",
    "Linux CI candidate must use upload-artifact v4",
  );
  assert(
    candidateUpload.with?.path === "apps/desktop/release-candidate/",
    "Linux CI candidate upload must use only the staged file set",
  );
  assert(
    candidateUpload.with?.["if-no-files-found"] === "error",
    "Linux CI candidate upload must fail if staging produced no files",
  );

  const proofUpload = stepNamed(linuxJob, "Upload Linux package proof");
  assert(
    proofUpload.uses === "actions/upload-artifact@v4" &&
      proofUpload.with?.path === "apps/desktop/release-proof/linux/",
    "Linux CI must retain native package proof logs separately",
  );
  assert(
    Number(candidateUpload.with?.["retention-days"]) >= 14 &&
      Number(proofUpload.with?.["retention-days"]) >= 14,
    "Linux CI package proof must be retained for at least 14 days",
  );
  assert(
    linuxJob.steps.indexOf(packageVerification) < linuxJob.steps.indexOf(candidateStage) &&
      linuxJob.steps.indexOf(candidateStage) < linuxJob.steps.indexOf(candidateUpload),
    "Linux CI must complete native validation before staging and uploading a candidate",
  );
}

function validateBuilderConfig(config, desktopPackage, afterRemoveSource) {
  assert(config.mac?.notarize === true, "electron-builder must notarize the macOS app");
  assert(
    JSON.stringify(config.mac?.target) ===
      JSON.stringify([
        { target: "dmg", arch: "universal" },
        { target: "zip", arch: "universal" },
      ]),
    "macOS packaging must produce a universal DMG and ZIP",
  );
  assert(
    config.mac?.x64ArchFiles === "**/*",
    "universal merge must allow identical unpacked Mach-O files in both slices",
  );
  assert(
    desktopPackage.scripts?.["package:dir"]?.includes("electron-builder --mac --dir --universal"),
    "unpacked macOS packaging must pass --universal because --dir ignores DMG/ZIP target arch",
  );
  assert(
    config.win?.signAndEditExecutable === true,
    "electron-builder must sign and edit the packaged Windows executable",
  );

  const targets = new Set((config.win?.target ?? []).map(({ target }) => target));
  assert(targets.has("nsis"), "Windows packaging must include NSIS");
  assert(targets.has("portable"), "Windows packaging must include portable");

  const setupName = "${productName}-${version}-${arch}-setup.${ext}";
  const portableName = "${productName}-${version}-${arch}-portable.${ext}";
  assert(config.nsis?.artifactName === setupName, `NSIS artifactName must be ${setupName}`);
  assert(
    config.portable?.artifactName === portableName,
    `portable artifactName must be ${portableName}`,
  );
  assert(
    config.nsis.artifactName !== config.portable.artifactName,
    "NSIS and portable artifacts must not share a filename",
  );

  assert(
    desktopPackage.homepage === "https://github.com/minghinmatthewlam/pi-gui",
    "Desktop package metadata must provide the Debian Homepage",
  );
  assert(
    desktopPackage.scripts?.["package:linux"]?.includes(linuxPackageCommand),
    "pnpm Linux packaging must build AppImage and deb for x64",
  );

  assert(config.linux?.executableName === "pi-gui", "Linux executable name must remain pi-gui");
  assert(
    config.linux?.maintainer === "Matthew Lam <minghinmatthew.lam@gmail.com>",
    "Linux package maintainer must include an email address",
  );
  assert(
    config.linux?.synopsis === "Codex-style desktop app for the pi coding agent",
    "Linux package synopsis must remain explicit",
  );
  assert(
    JSON.stringify(config.linux?.target) ===
      JSON.stringify([
        { target: "AppImage", arch: ["x64"] },
        { target: "deb", arch: ["x64"] },
      ]),
    "Linux packaging must produce x64 AppImage and deb targets",
  );

  assert(
    config.deb?.artifactName === "${productName}_${version}_${arch}.${ext}",
    "Debian artifact naming must remain deterministic",
  );
  assert(config.deb?.packageName === "pi-gui", "Debian package name must remain pi-gui");
  assert(config.deb?.packageCategory === "devel", "Debian Section must remain devel");
  assert(config.deb?.priority === "optional", "Debian Priority must remain optional");
  assert(
    config.deb?.afterRemove === "resources/linux/after-remove.sh",
    "Debian packaging must use the corrected removal hook",
  );
  assert(
    JSON.stringify(config.deb?.depends) === JSON.stringify(linuxDependencies),
    "Debian dependencies must match the validated runtime dependency set",
  );
  assert(
    afterRemoveSource.includes(
      "update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'",
    ) &&
      !afterRemoveSource.includes(
        "update-alternatives --remove '${executable}' '/usr/bin/${executable}'",
      ),
    "Debian removal must unregister the alternatives target, not the link",
  );
}

function validateBuildJob(job, platform) {
  const upload = stepNamed(job, `Upload immutable ${platform} candidate`);
  assert(upload.uses === "actions/upload-artifact@v4", `${platform} must use upload-artifact v4`);
  assert(
    upload.with?.["if-no-files-found"] === "error",
    `${platform} candidate upload must fail when files are missing`,
  );
  assert(upload.with?.overwrite !== true, `${platform} candidate upload must remain immutable`);

  const stage = stepNamed(job, `Stage validated ${platform} artifacts`);
  assert(
    runText(stage).includes("release-artifacts.mjs stage"),
    `${platform} candidate must be staged through the release manifest helper`,
  );
}

function validateWorkflow(
  workflow,
  finalizerSource,
  linuxVerifierSource,
  windowsVerifierSource,
) {
  const jobs = workflow.jobs ?? {};
  const releasePreflight = jobs["release-preflight"];
  const versionCheck = stepNamed(
    releasePreflight,
    "Verify release tag and product versions",
  );
  assert(
    runText(versionCheck).includes("verify-release-version.mjs") &&
      runText(versionCheck).includes('--tag "$GITHUB_REF_NAME"'),
    "Release preflight must require the exact tag across product package versions",
  );
  for (const jobName of ["build-macos", "build-linux", "build-windows"]) {
    assert(
      jobs[jobName]?.needs === "release-preflight",
      `${jobName} must wait for release version preflight`,
    );
  }

  const releaseSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter(({ uses }) => uses === "softprops/action-gh-release@v2")
      .map((step) => ({ jobName, step })),
  );
  assert(releaseSteps.length === 1, "Release workflow must have exactly one GitHub release action");
  assert(
    releaseSteps[0].jobName === "stage-draft",
    "Only the draft staging job may upload release assets",
  );
  assert(workflow.permissions?.contents === "read", "Release workflow must default to read access");

  validateBuildJob(jobs["build-macos"], "macOS");
  validateBuildJob(jobs["build-linux"], "Linux");
  validateBuildJob(jobs["build-windows"], "Windows");

  const macFinalize = stepNamed(jobs["build-macos"], "Notarize and verify final macOS artifacts");
  const macRefresh = stepNamed(jobs["build-macos"], "Refresh update metadata from final DMG");
  const macStage = stepNamed(jobs["build-macos"], "Stage validated macOS artifacts");
  assert(
    runText(macFinalize).includes("finalize-macos-release.sh"),
    "macOS build must run final DMG notarization and trust validation",
  );
  assert(
    macFinalize["continue-on-error"] !== true,
    "Final macOS validation must be fatal",
  );
  for (const command of [
    "set -euo pipefail",
    "notarytool submit",
    "stapler staple",
    "stapler validate",
    "spctl --assess --type open",
  ]) {
    assert(finalizerSource.includes(command), `macOS finalizer must contain: ${command}`);
  }
  assert(
    runText(macRefresh).includes("refresh-macos-update-metadata.mjs"),
    "macOS build must regenerate update metadata from the stapled DMG",
  );
  assert(
    jobs["build-macos"].steps.indexOf(macFinalize) <
      jobs["build-macos"].steps.indexOf(macRefresh) &&
      jobs["build-macos"].steps.indexOf(macRefresh) <
        jobs["build-macos"].steps.indexOf(macStage),
    "macOS metadata refresh must run after stapling and before artifact staging",
  );

  const linuxJob = jobs["build-linux"];
  const linuxPackage = stepNamed(linuxJob, "Package Linux AppImage and deb");
  assert(
    runText(linuxPackage).includes("electron-builder --linux") &&
      !runText(linuxPackage).includes("--linux AppImage") &&
      !runText(linuxPackage).includes("--x64"),
    "Linux release packaging must use the validated target and architecture configuration",
  );
  const linuxBuildVerification = stepNamed(linuxJob, "Verify Linux packages");
  assert(
    runText(linuxBuildVerification).includes("verify-linux-release.sh") &&
      runText(linuxBuildVerification).includes("--install"),
    "Linux build must natively validate both packages and the install lifecycle",
  );
  const linuxStage = stepNamed(linuxJob, "Stage validated Linux artifacts");
  assert(
    linuxJob.steps.indexOf(linuxBuildVerification) < linuxJob.steps.indexOf(linuxStage),
    "Linux release validation must complete before candidate staging",
  );
  const linuxProofUpload = stepNamed(linuxJob, "Upload Linux package proof");
  assert(
    linuxProofUpload.uses === "actions/upload-artifact@v4" &&
      linuxProofUpload.with?.path === "apps/desktop/release-proof/linux-build/" &&
      Number(linuxProofUpload.with?.["retention-days"]) >= 14,
    "Linux release build must retain native package proof for at least 14 days",
  );
  assert(
    !String(linuxProofUpload.with?.name).startsWith("release-"),
    "Linux proof artifacts must not match the immutable release candidate download pattern",
  );
  for (const marker of [
    "--appimage-extract",
    '"$extracted/AppRun"',
    '"$extracted/pi-gui"',
    "resources/app.asar",
    "dpkg-deb --info",
    "dpkg-deb --contents",
    "dpkg-deb --control",
    "dpkg-deb --raw-extract",
    "ELECTRON_RUN_AS_NODE=1",
    "native-node-pty-runtime.txt",
    "chrome-sandbox-owner-mode.txt",
    "xvfb-run",
    "apt-get install -y",
    "apt-get purge -y",
    "desktop-file-utils",
    "xauth",
    "xvfb",
  ]) {
    assert(
      linuxVerifierSource.includes(marker),
      `Linux package verifier must contain: ${marker}`,
    );
  }

  const windowsJob = jobs["build-windows"];
  const signingCheck = stepNamed(windowsJob, "Validate Windows signing credentials");
  const packageStep = stepNamed(windowsJob, "Package Windows");
  assert(
    JSON.stringify(signingCheck.env).includes("secrets.WINDOWS_CSC_LINK") &&
      JSON.stringify(signingCheck.env).includes("secrets.WINDOWS_CSC_KEY_PASSWORD"),
    "Windows build must require dedicated signing secrets",
  );
  assert(
    JSON.stringify(packageStep.env).includes("secrets.WINDOWS_CSC_LINK") &&
      JSON.stringify(packageStep.env).includes("secrets.WINDOWS_CSC_KEY_PASSWORD"),
    "Windows signing secrets must map to electron-builder CSC variables",
  );
  const windowsBuildVerification = stepNamed(
    windowsJob,
    "Verify Windows signatures and architecture",
  );
  assert(
    runText(windowsBuildVerification).includes("-SmokePackages"),
    "Windows build must smoke-test both downloadable packages",
  );
  for (const marker of [
    "Get-AuthenticodeSignature",
    'Start-Process `',
    '"/S"',
    '"t", $setup',
    '"t", $portable',
    '"x", "-y"',
    '"app-*.7z"',
    "Assert-X64Pe $installedApp",
    "Assert-X64Pe $portableApp",
  ]) {
    assert(
      windowsVerifierSource.includes(marker),
      `Windows package verifier must contain: ${marker}`,
    );
  }

  const stageDraft = jobs["stage-draft"];
  assert(
    JSON.stringify(stageDraft.needs) ===
      JSON.stringify(["build-macos", "build-linux", "build-windows"]),
    "Draft staging must wait for every platform candidate",
  );
  assert(
    stageDraft.permissions?.contents === "write",
    "Draft staging needs release write permission",
  );

  const steps = stageDraft.steps ?? [];
  const candidateIndex = steps.findIndex(({ name }) => name === "Validate combined release candidate");
  const stateCheck = stepNamed(stageDraft, "Check existing release state");
  const stateCheckIndex = steps.indexOf(stateCheck);
  const uploadIndex = steps.findIndex(({ uses }) => uses === "softprops/action-gh-release@v2");
  assert(
    candidateIndex >= 0 &&
      candidateIndex < stateCheckIndex &&
      stateCheckIndex < uploadIndex,
    "Candidate validation and fail-closed state lookup must precede draft upload",
  );
  assert(
    runText(stateCheck).includes("github-release-state.mjs") &&
      !runText(stateCheck).includes("gh release view"),
    "Existing release lookup must use the fail-closed API state checker",
  );

  const release = releaseSteps[0].step;
  assert(release.with?.draft === true, "Release assets must be uploaded to a draft");
  assert(
    release.with?.fail_on_unmatched_files === true,
    "Draft upload must fail on unmatched artifact paths",
  );

  const draftVerifiers = [
    ["verify-draft-macos", "Verify draft macOS trust"],
    ["verify-draft-linux", "Verify draft Linux packages"],
    ["verify-draft-windows", "Verify draft Windows signatures"],
  ];
  for (const [jobName, trustStep] of draftVerifiers) {
    const job = jobs[jobName];
    assert(job?.needs === "stage-draft", `${jobName} must wait for draft staging`);
    assert(
      runText(stepNamed(job, "Download draft release")).includes("gh release download"),
      `${jobName} must download the draft release`,
    );
    assert(
      runText(stepNamed(job, "Verify draft manifests and bytes")).includes("--platform all"),
      `${jobName} must verify the complete draft byte set`,
    );
    stepNamed(job, trustStep);
  }
  assert(
    runText(stepNamed(jobs["verify-draft-linux"], "Verify draft Linux packages")).includes(
      "verify-linux-release.sh",
    ) &&
      runText(stepNamed(jobs["verify-draft-linux"], "Verify draft Linux packages")).includes(
        "--install",
    ),
    "Downloaded draft Linux packages must be installed and validated",
  );
  assert(
    runText(stepNamed(jobs["verify-draft-windows"], "Verify draft Windows signatures")).includes(
      "-SmokePackages",
    ),
    "Downloaded draft Windows packages must be installed and extracted",
  );

  const publish = jobs.publish;
  assert(
    JSON.stringify(publish.needs) ===
      JSON.stringify(["verify-draft-macos", "verify-draft-linux", "verify-draft-windows"]),
    "Final publication must wait for all native draft trust checks",
  );
  assert(publish.environment === "release", "Final publication must use the release environment gate");
  assert(publish.permissions?.contents === "write", "Final publication needs release write permission");

  const publishSteps = publish.steps ?? [];
  const requireIndex = publishSteps.findIndex(({ name }) => name === "Require the validated draft");
  const revalidateIndex = publishSteps.findIndex(
    ({ name }) => name === "Revalidate draft bytes before publication",
  );
  const publishIndex = publishSteps.findIndex(({ name }) => name === "Publish validated draft");
  const publishedVerifyIndex = publishSteps.findIndex(
    ({ name }) => name === "Verify published release bytes",
  );
  assert(
    requireIndex >= 0 &&
      requireIndex < revalidateIndex &&
      revalidateIndex < publishIndex &&
      publishIndex < publishedVerifyIndex,
    "Draft state, bytes, publication, and public-byte verification must remain ordered",
  );
  assert(
    runText(publishSteps[requireIndex]).includes("github-release-state.mjs --require-draft"),
    "Final publication must fail closed unless the validated draft still exists",
  );
  assert(
    runText(publishSteps[revalidateIndex]).includes("--platform all"),
    "Final publication must revalidate unchanged draft bytes",
  );
  assert(
    runText(publishSteps[publishIndex]).includes("--draft=false"),
    "Only the final gated job may publish the validated draft",
  );
  assert(
    runText(publishSteps[publishedVerifyIndex]).includes("--platform all"),
    "Published release bytes must be redownloaded and verified",
  );

  const draftClears = Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter((step) => runText(step).includes("--draft=false"))
      .map(() => jobName),
  );
  assert(
    JSON.stringify(draftClears) === JSON.stringify(["publish"]),
    "Exactly one final job may clear the draft flag",
  );

  const writeJobs = Object.entries(jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([jobName]) => jobName);
  assert(
    JSON.stringify(writeJobs) === JSON.stringify(["stage-draft", "publish"]),
    "Only draft staging and final publication may have release write permission",
  );

  const publishedVerifiers = [
    ["verify-published-macos", "Verify published macOS trust"],
    ["verify-published-linux", "Verify published Linux packages"],
    ["verify-published-windows", "Verify published Windows signatures"],
  ];
  for (const [jobName, trustStep] of publishedVerifiers) {
    const job = jobs[jobName];
    assert(job?.needs === "publish", `${jobName} must wait for publication`);
    assert(
      runText(stepNamed(job, "Download published release")).includes("gh release download"),
      `${jobName} must redownload the published release`,
    );
    assert(
      runText(stepNamed(job, "Verify published manifests and bytes")).includes("--platform all"),
      `${jobName} must verify the complete published byte set`,
    );
    stepNamed(job, trustStep);
  }
  assert(
    runText(
      stepNamed(jobs["verify-published-linux"], "Verify published Linux packages"),
    ).includes("verify-linux-release.sh") &&
      runText(
        stepNamed(jobs["verify-published-linux"], "Verify published Linux packages"),
      ).includes("--install"),
    "Published Linux packages must be installed and validated",
  );
  assert(
    runText(
      stepNamed(jobs["verify-published-windows"], "Verify published Windows signatures"),
    ).includes("-SmokePackages"),
    "Published Windows packages must be installed and extracted",
  );

  assert(
    JSON.stringify(jobs["sync-homebrew"]?.needs) ===
      JSON.stringify([
        "verify-published-macos",
        "verify-published-linux",
        "verify-published-windows",
      ]),
    "Homebrew sync must wait for every post-publication native verification",
  );
  assert(
    runText(stepNamed(jobs["sync-homebrew"], "Download published DMG")).includes(
      "-universal.dmg",
    ) &&
      runText(stepNamed(jobs["sync-homebrew"], "Sync Homebrew tap")).includes(
        "-universal.dmg",
      ),
    "Homebrew sync must consume the universal macOS DMG",
  );
}

const [
  builderConfig,
  ciWorkflow,
  workflow,
  finalizerSource,
  linuxVerifierSource,
  windowsVerifierSource,
  desktopPackageSource,
  afterRemoveSource,
] = await Promise.all([
  parseYaml("apps/desktop/electron-builder.yml"),
  parseYaml(".github/workflows/ci.yml"),
  parseYaml(".github/workflows/release.yml"),
  readFile(path.join(scriptDir, "finalize-macos-release.sh"), "utf8"),
  readFile(path.join(scriptDir, "verify-linux-release.sh"), "utf8"),
  readFile(path.join(scriptDir, "verify-windows-release.ps1"), "utf8"),
  readFile(path.join(scriptDir, "..", "package.json"), "utf8"),
  readFile(path.join(scriptDir, "..", "resources", "linux", "after-remove.sh"), "utf8"),
]);

await validateConfiguration(builderConfig, new DebugLogger(false));
validateBuilderConfig(builderConfig, JSON.parse(desktopPackageSource), afterRemoveSource);
validateCiWorkflow(ciWorkflow);
validateWorkflow(
  workflow,
  finalizerSource,
  linuxVerifierSource,
  windowsVerifierSource,
);
console.log("Release package and workflow configuration are valid.");
