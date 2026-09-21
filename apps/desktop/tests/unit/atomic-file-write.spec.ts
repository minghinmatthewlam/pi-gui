import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { writeFileAtomicQueued } from "../../electron/persistence/atomic-file-write";

test("keeps ui-state readable while a new version replaces it", async () => {
  const filePath = join(await mkdtemp(join(tmpdir(), "ui-state-replace-")), "ui-state.json");
  const validate = (value: unknown) => value;
  await writeFileAtomicQueued(filePath, '{"n":0}\n', validate);
  let missing = 0;
  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      try {
        await readFile(filePath, "utf8");
        reads += 1;
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
        missing += 1;
      }
    }
  })();

  for (let n = 1; n <= 30; n += 1) {
    await writeFileAtomicQueued(filePath, `{"n":${n}}\n`, validate);
  }
  stop = true;
  await reader;

  expect(reads).toBeGreaterThan(0);
  expect(missing).toBe(0);
});

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
