import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

/** @typedef {keyof typeof ACTION_POLICY} ActionId */

const ACTION_POLICY = Object.freeze({
  "actions/checkout": "v7",
  "actions/setup-node": "v7",
  "pnpm/action-setup": "v6",
  "actions/upload-artifact": "v7",
  "actions/download-artifact": "v8",
  "softprops/action-gh-release": "v3",
});

const MAJOR_REF = /^v\d+$/;
const RUNTIME_SHIMS = [
  "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24",
  "ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION",
];

/**
 * @param {unknown} uses
 * @returns {string | undefined}
 */
function actionIdFromUses(uses) {
  if (typeof uses !== "string") {
    return undefined;
  }
  const at = uses.lastIndexOf("@");
  return at === -1 ? uses : uses.slice(0, at);
}

/**
 * @param {unknown} uses
 * @returns {string}
 */
function refFromUses(uses) {
  if (typeof uses !== "string") {
    return "";
  }
  const at = uses.lastIndexOf("@");
  return at === -1 ? "" : uses.slice(at + 1);
}

/**
 * @param {unknown} uses
 * @param {ActionId} name
 * @returns {boolean}
 */
export function isAction(uses, name) {
  return actionIdFromUses(uses) === name;
}

/**
 * @param {unknown} uses
 * @returns {boolean}
 */
function isIgnoredUses(uses) {
  return typeof uses === "string" && (uses.startsWith("./") || uses.startsWith("docker://"));
}

/**
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
export async function assertWorkflowActionPolicy(repoRoot) {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const files = (await readdir(workflowDir))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  /** @type {string[]} */
  const violations = [];
  const seen = new Set();

  for (const file of files) {
    const relativePath = `.github/workflows/${file}`;
    const source = await readFile(path.join(workflowDir, file), "utf8");
    for (const shim of RUNTIME_SHIMS) {
      if (source.includes(shim)) {
        violations.push(`${relativePath}: must not set ${shim}`);
      }
    }

    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      violations.push(
        `${relativePath}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      );
      continue;
    }

    const workflow = document.toJS();
    const jobs = workflow?.jobs ?? {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const hasPnpmSetup = steps.some((step) => isAction(step?.uses, "pnpm/action-setup"));
      for (const [stepIndex, step] of steps.entries()) {
        const uses = step?.uses;
        if (uses == null) {
          continue;
        }
        const location = `${relativePath} ${jobId} step ${stepIndex}`;
        if (typeof uses !== "string") {
          violations.push(`${location}: uses must be a string`);
          continue;
        }
        if (isIgnoredUses(uses)) {
          continue;
        }

        const actionId = actionIdFromUses(uses);
        const ref = refFromUses(uses);
        const required = actionId ? ACTION_POLICY[actionId] : undefined;
        if (!required) {
          violations.push(`${location}: unknown remote action ${uses}`);
          continue;
        }
        seen.add(actionId);
        if (!MAJOR_REF.test(ref) || ref !== required) {
          violations.push(`${location}: expected ${actionId}@${required}, found ${uses}`);
        }
        if (actionId !== "actions/setup-node") {
          continue;
        }
        if (String(step.with?.["node-version"] ?? "") !== "22") {
          violations.push(`${location}: setup-node node-version must be 22`);
        }
        const cache = step.with?.cache;
        if (hasPnpmSetup) {
          if (cache !== "pnpm") {
            violations.push(`${location}: jobs that install pnpm must set cache: pnpm`);
          }
        } else if (cache != null) {
          violations.push(`${location}: jobs without pnpm/action-setup must omit cache`);
        }
        if (step.with?.["package-manager-cache"] != null) {
          violations.push(`${location}: do not set package-manager-cache`);
        }
      }
    }
  }

  for (const [actionId, required] of Object.entries(ACTION_POLICY)) {
    if (!seen.has(actionId)) {
      violations.push(`missing required action ${actionId}@${required}`);
    }
  }

  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }
}
