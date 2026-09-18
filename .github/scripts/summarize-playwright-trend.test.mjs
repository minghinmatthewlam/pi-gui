import assert from "node:assert/strict";
import test from "node:test";
import { summarizePlaywrightReport } from "./summarize-playwright-trend.mjs";

test("groups failures by spec file without merging unrelated surfaces", () => {
  const summary = summarizePlaywrightReport({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    errors: [],
    suites: [
      {
        title: "core/timeline-pinning.spec.ts",
        specs: [
          {
            title: "keeps a virtualized thread off-bottom",
            file: "core/timeline-pinning.spec.ts",
            line: 426,
            column: 5,
            tests: [
              { status: "expected", results: [{ status: "passed", errors: [], duration: 1234 }] },
            ],
          },
        ],
      },
      {
        title: "core/persistence.spec.ts",
        suites: [
          {
            title: "persistence",
            specs: [
              {
                title: "preserves durable ui state",
                file: "core/persistence.spec.ts",
                line: 377,
                column: 5,
                tests: [
                  {
                    status: "unexpected",
                    results: [
                      {
                        status: "failed",
                        duration: 4321,
                        errors: [{ message: "composerDraftsBySession missing" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(summary.groups[0].durationMs, 4321);
  assert.equal(summary.groups[1].durationMs, 1234);
  assert.deepEqual(
    summary.groups.map((group) => group.specFile),
    ["core/persistence.spec.ts", "core/timeline-pinning.spec.ts"],
  );
  assert.deepEqual(summary.groups[0]?.counts, {
    expected: 0,
    unexpected: 1,
    flaky: 0,
    skipped: 0,
  });
  assert.deepEqual(summary.groups[0]?.failures, [
    {
      title: "preserves durable ui state",
      line: 377,
      column: 5,
      status: "unexpected",
      errors: ["composerDraftsBySession missing"],
    },
  ]);
  assert.deepEqual(summary.groups[1]?.counts, {
    expected: 1,
    unexpected: 0,
    flaky: 0,
    skipped: 0,
  });
});
