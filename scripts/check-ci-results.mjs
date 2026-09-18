import { pathToFileURL } from "node:url";

export const requiredJobs = [
  "typecheck",
  "website-build",
  "desktop-core",
  "desktop-package-linux",
  "desktop-package-windows",
];

export const coreShardJobs = ["desktop-core-shards"];

export function checkCiResults(needs, expectedJobs = requiredJobs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    return ["CI needs must be an object containing every required job result."];
  }
  const failures = [];
  for (const job of expectedJobs) {
    const result = Object.hasOwn(needs, job) ? needs[job]?.result : undefined;
    if (result !== "success") {
      failures.push(
        `${job}: expected success, received ${String(result ?? "missing")}. Inspect that job's logs and rerun CI after fixing it.`,
      );
    }
  }
  for (const job of Object.keys(needs)) {
    if (!expectedJobs.includes(job)) {
      failures.push(
        `${job}: unexpected dependency. Update the required-job contract and its tests.`,
      );
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--core-shards")) {
      throw new Error("Usage: check-ci-results.mjs [--core-shards]");
    }
    const expectedJobs = args.length ? coreShardJobs : requiredJobs;
    const failures = checkCiResults(JSON.parse(process.env.CI_NEEDS ?? "null"), expectedJobs);
    if (failures.length) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`All ${expectedJobs.length} required CI jobs succeeded.`);
    }
  } catch (error) {
    console.error(`Cannot read CI_NEEDS: ${error.message}`);
    process.exitCode = 1;
  }
}
