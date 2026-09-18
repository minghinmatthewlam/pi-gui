import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkCiResults, requiredJobs } from "./check-ci-results.mjs";

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
    sorted(requiredJobs),
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
