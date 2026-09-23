import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isAction } from "./workflow-action-policy.mjs";
import { checkCiResults, requiredJobs, coreShardJobs } from "./check-ci-results.mjs";

const passing = () => Object.fromEntries(requiredJobs.map((job) => [job, { result: "success" }]));
const script = fileURLToPath(new URL("./check-ci-results.mjs", import.meta.url));

test("all required jobs must succeed", () => {
  assert.deepEqual(checkCiResults(passing()), []);
  for (const job of requiredJobs) {
    for (const result of ["failure", "cancelled", "skipped", "neutral", "", undefined]) {
      const needs = passing();
      needs[job] = { result };
      const failures = checkCiResults(needs);
      assert.equal(failures.length, 1);
      assert.match(failures[0], new RegExp(`${job}: expected success`));
    }
    const needs = passing();
    delete needs[job];
    assert.equal(checkCiResults(needs).length, 1);
  }
});

test("missing, malformed, or unexpected results fail closed", () => {
  for (const needs of [
    undefined,
    null,
    [],
    "success",
    {},
    { ...passing(), unexpected: { result: "success" } },
  ]) {
    assert.ok(checkCiResults(needs).length > 0);
  }
});

test("CLI exit status reflects the result and rejects invalid JSON", () => {
  for (const [input, status] of [
    [JSON.stringify(passing()), 0],
    ["{}", 1],
    ["not-json", 1],
    ["", 1],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CI_NEEDS: input },
      encoding: "utf8",
    });
    assert.equal(result.status, status, result.stderr);
    if (status === 1) assert.ok(result.stderr.length > 0);
  }
});

test("workflow aggregate covers every job and cannot ignore unsuccessful checks", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const gate = workflow.jobs["ci-required"];
  const sorted = (values) => [...values].sort();
  assert.deepEqual(
    sorted(Object.keys(workflow.jobs).filter((job) => job !== "ci-required")),
    sorted([...requiredJobs, ...coreShardJobs]),
  );
  assert.deepEqual(sorted(gate.needs), sorted(requiredJobs));
  assert.equal(gate.name, "CI required");
  assert.equal(gate.if, "${{ always() }}");
  const checks = gate.steps.filter((step) => step.run === "node scripts/check-ci-results.mjs");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].env.CI_NEEDS, "${{ toJSON(needs) }}");
  assert.equal(checks[0].if, undefined);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job["continue-on-error"] === undefined || job["continue-on-error"] === false);
    for (const step of job.steps) {
      assert.ok(step["continue-on-error"] === undefined || step["continue-on-error"] === false);
    }
  }
});

function assertBaselineRuns(workflow) {
  const baseline = workflow.jobs.typecheck;
  assert.equal(baseline.if, undefined, "The baseline job must run on every CI invocation");
  const checks = baseline.steps.filter((step) => step.run === "pnpm check");
  assert.equal(checks.length, 1, "CI must run the canonical pnpm check command exactly once");
  assert.equal(checks[0].if, undefined, "The pnpm check step must not be conditional");
  assert.ok(
    checks[0]["continue-on-error"] === undefined || checks[0]["continue-on-error"] === false,
    "A failed baseline must fail CI",
  );
}

test("CI runs the canonical baseline unconditionally", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assertBaselineRuns(workflow);
  for (const mutate of [
    (copy) => {
      copy.jobs.typecheck.if = "false";
    },
    (copy) => {
      copy.jobs.typecheck.steps.find((step) => step.run === "pnpm check").if = "false";
    },
    (copy) => {
      copy.jobs.typecheck.steps.find((step) => step.run === "pnpm check").run = "echo skipped";
    },
    (copy) => {
      copy.jobs.typecheck.steps.find((step) => step.run === "pnpm check")["continue-on-error"] =
        true;
    },
  ]) {
    const invalid = structuredClone(workflow);
    mutate(invalid);
    assert.throws(() => assertBaselineRuns(invalid), /baseline|pnpm check/);
  }
});

function assertCoreShards(workflow) {
  const gate = workflow.jobs["desktop-core"];
  assert.equal(gate.name, "desktop-core");
  assert.equal(gate.if, "${{ always() }}");
  assert.equal(gate.needs, "desktop-core-shards");
  const check = gate.steps.find(
    (step) => step.run === "node scripts/check-ci-results.mjs --core-shards",
  );
  assert.ok(check, "Core gate must validate shard results");
  assert.equal(check.env.CI_NEEDS, "${{ toJSON(needs) }}");
  assert.equal(check.if, undefined);
  const matrix = workflow.jobs["desktop-core-shards"];
  assert.equal(matrix.if, undefined);
  assert.deepEqual(matrix.strategy.matrix, { shard: [1, 2, 3, 4] });
  assert.equal(matrix.strategy["fail-fast"], false);
  // PRs run Core on Linux and main pushes on macOS; each runner OS gets exactly one Core step.
  assert.equal(
    matrix["runs-on"],
    "${{ github.event_name == 'pull_request' && 'ubuntu-latest' || 'macos-latest' }}",
  );
  const mac = matrix.steps.find((step) => step.name === "Desktop Core (macOS)");
  assert.equal(mac.if, "${{ runner.os == 'macOS' }}");
  assert.equal(
    mac.run,
    "pnpm --filter @pi-gui/desktop run test:e2e:ci:mac --shard=${{ matrix.shard }}/4 --reporter=line,json",
  );
  const linux = matrix.steps.find((step) => step.name === "Desktop Core (Linux)");
  assert.equal(linux.if, "${{ runner.os == 'Linux' }}");
  assert.match(
    linux.run,
    /^xvfb-run .* pnpm --filter @pi-gui\/desktop run test:e2e:core --shard=\$\{\{ matrix\.shard \}\}\/4 --reporter=line,json$/,
  );
  const upload = matrix.steps.find((step) => isAction(step.uses, "actions/upload-artifact"));
  assert.equal(upload.with.name, "desktop-core-test-results-${{ matrix.shard }}");
}

test("all Core shards are required and retain independent reports", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assertCoreShards(workflow);
  for (const mutate of [
    (w) => {
      w.jobs["desktop-core"].needs = "typecheck";
    },
    (w) => {
      w.jobs["desktop-core"].if = "success()";
    },
    (w) => {
      w.jobs["desktop-core-shards"].strategy.matrix.shard = [1, 2, 3];
    },
    (w) => {
      w.jobs["desktop-core-shards"].steps.find((s) => s.name === "Desktop Core (macOS)").run =
        "echo skipped";
    },
    (w) => {
      w.jobs["desktop-core-shards"].steps.find((s) => s.name === "Desktop Core (Linux)").run =
        "echo skipped";
    },
    (w) => {
      w.jobs["desktop-core-shards"].steps.find((s) => s.name === "Desktop Core (Linux)").if =
        "${{ false }}";
    },
  ]) {
    const invalid = structuredClone(workflow);
    mutate(invalid);
    assert.throws(() => assertCoreShards(invalid));
  }
  for (const result of ["success", "failure", "cancelled", "skipped", undefined]) {
    const needs = { "desktop-core-shards": { result } };
    assert.equal(checkCiResults(needs, coreShardJobs).length, result === "success" ? 0 : 1);
    const child = spawnSync(process.execPath, [script, "--core-shards"], {
      env: { ...process.env, CI_NEEDS: JSON.stringify(needs) },
      encoding: "utf8",
    });
    assert.equal(child.status, result === "success" ? 0 : 1, child.stderr);
  }
  assert.ok(checkCiResults({}, coreShardJobs).length > 0);
});
