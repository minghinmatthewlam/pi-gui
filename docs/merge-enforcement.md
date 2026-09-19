# Required CI results

The `CI required` job in `.github/workflows/ci.yml` waits for every other job and
uses `always()` so a failed or skipped dependency does not skip the aggregate.
`scripts/check-ci-results.mjs` accepts only the exact required dependency set with
every result equal to `success`. Missing, skipped, cancelled, failed, and unknown
results fail. The check prints the affected job and tells the reader to inspect
its logs and rerun after repair.

The checker is dependency-free; it runs on Node 22 without a package install.
Its tests parse the workflow and require every nonaggregate job to be covered,
prevent `continue-on-error`, and exercise failing results and the CLI exit status.

## GitHub activation

Adding a workflow is not sufficient to enforce merging. After this workflow has
run successfully on a real pull request, add the exact check name `CI required`
to the existing `main` branch protection or ruleset. Preserve the existing five
required checks and the requirement that the branch be up to date. Bind checks
to the observed GitHub Actions app identity where supported; inspect bypass
permissions separately. Do not replace existing rules with a partial payload.

Verify activation against the live ruleset and a real pull-request run. Locally
passing tests prove the result decision and workflow configuration, not that
GitHub blocks a merge. The existing repository-admin bypass is an explicit
policy exception; this rollout does not remove it.

Whole-workflow cancellation can interrupt even an `always()` job. In that case
the required aggregate must remain non-successful; branch rules supply the merge
block. This mechanism does not prevent an authorized author from modifying the
checker or workflow: review and protection of CI policy changes remain necessary.
