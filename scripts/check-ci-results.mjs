import { pathToFileURL } from "node:url";

export const requiredJobs = [
  "typecheck",
  "website-build",
  "desktop-core",
  "desktop-package-linux",
  "desktop-package-windows",
];

export function checkCiResults(needs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    return ["CI needs must be an object containing every required job result."];
  }
  const failures = [];
  for (const job of requiredJobs) {
    const result = Object.hasOwn(needs, job) ? needs[job]?.result : undefined;
    if (result !== "success") {
      failures.push(
        `${job}: expected success, received ${String(result ?? "missing")}. Inspect that job's logs and rerun CI after fixing it.`,
      );
    }
  }
  for (const job of Object.keys(needs)) {
    if (!requiredJobs.includes(job)) {
      failures.push(
        `${job}: unexpected dependency. Update the required-job contract and its tests.`,
      );
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = checkCiResults(JSON.parse(process.env.CI_NEEDS ?? "null"));
    if (failures.length) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`All ${requiredJobs.length} required CI jobs succeeded.`);
    }
  } catch (error) {
    console.error(`Cannot read CI_NEEDS: ${error.message}`);
    process.exitCode = 1;
  }
}
