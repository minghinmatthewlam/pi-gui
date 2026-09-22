import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  decodeChangeReviewFileStageInput,
  decodeGetReviewInput,
  decodeReviewFileInput,
  decodeReviewScope,
  decodeResolveTurnReviewInput,
  decodeSetReviewFileReviewedInput,
  type AvailableReview,
  type ReviewResult,
} from "../../contracts/review";
import { ReviewOwner, type ReviewCheckpointSource } from "../../electron/workbench/review-owner";
import { ReviewedStore } from "../../electron/workbench/reviewed-store";

const execFileAsync = promisify(execFile);
const firstTask = { workspaceId: "workspace", sessionId: "first" };
const secondTask = { workspaceId: "workspace", sessionId: "second" };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", [...args], { cwd })).stdout.trim();
}

async function fixture() {
  const checkoutPath = await mkdtemp(join(tmpdir(), "pi-gui-review-owner-repo-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-gui-review-owner-data-"));
  await git(checkoutPath, ["init", "-b", "trunk"]);
  await git(checkoutPath, ["config", "user.name", "Review Test"]);
  await git(checkoutPath, ["config", "user.email", "review@example.invalid"]);
  await writeFile(join(checkoutPath, "example.txt"), "before\n");
  await git(checkoutPath, ["add", "example.txt"]);
  await git(checkoutPath, ["commit", "-m", "baseline"]);
  await writeFile(join(checkoutPath, "example.txt"), "after\n");
  const options = {
    userDataDir,
    resolveCheckoutPath: (id: string) => (id === "checkout" ? checkoutPath : undefined),
    validateTask: (target: typeof firstTask) => target.workspaceId === "workspace",
  };
  return { checkoutPath, userDataDir, options, owner: new ReviewOwner(options) };
}

function available(result: ReviewResult): AvailableReview {
  if (result.state !== "available") throw new Error(`${result.code}: ${result.message}`);
  return result;
}

test("review requests reject foreign fields, malformed identities and mixed scope arguments", () => {
  const valid = { target: firstTask, checkoutId: "checkout", scope: { kind: "uncommitted" } };
  expect(decodeGetReviewInput(valid)).toEqual(valid);
  expect(decodeReviewScope({ kind: "branch", baseRef: "refs/heads/trunk" })).toEqual({
    kind: "branch",
    baseRef: "refs/heads/trunk",
  });
  expect(decodeReviewScope({ kind: "turn" })).toEqual({ kind: "turn" });
  expect(decodeResolveTurnReviewInput({ target: firstTask, messageId: "entry" })).toEqual({
    target: firstTask,
    messageId: "entry",
  });
  expect(() => decodeResolveTurnReviewInput({ target: firstTask, messageId: "" })).toThrow();
  expect(() => decodeGetReviewInput({ ...valid, cwd: "/arbitrary" })).toThrow();
  expect(() =>
    decodeGetReviewInput({ ...valid, target: { ...firstTask, sessionId: "" } }),
  ).toThrow();
  expect(() => decodeReviewScope({ kind: "branch", checkpointId: "turn" })).toThrow();
  expect(() => decodeReviewScope({ kind: "turn", baseRef: "main" })).toThrow();
  expect(() => decodeReviewScope({ kind: "uncommitted", baseRef: "main" })).toThrow();
  expect(() => decodeReviewScope({ kind: "branch", baseRef: "bad\0ref" })).toThrow();
  expect(() =>
    decodeReviewFileInput({ reviewId: "review", fileId: "file", path: "escape" }),
  ).toThrow();
  expect(() =>
    decodeSetReviewFileReviewedInput({ reviewId: "review", fileId: "file", reviewed: "true" }),
  ).toThrow();
  expect(() =>
    decodeChangeReviewFileStageInput({ reviewId: "review", fileId: "file", action: "reset" }),
  ).toThrow();
});

test("review acknowledgements survive new comparisons and restart but do not cross task or content identity", async () => {
  const { checkoutPath, options, owner } = await fixture();
  const input = {
    target: firstTask,
    checkoutId: "checkout",
    scope: { kind: "uncommitted" as const },
  };
  const first = available(await owner.getReview(input));
  const file = first.files.find((entry) => entry.path === "example.txt");
  expect(file).toBeDefined();
  if (!file) throw new Error("Expected changed example.txt");
  await expect(
    owner.setReviewFileReviewed({ reviewId: first.reviewId, fileId: file.id, reviewed: true }),
  ).resolves.toMatchObject({ state: "available", reviewed: true });

  const restored = available(await new ReviewOwner(options).getReview(input));
  expect(restored.reviewId).not.toBe(first.reviewId);
  expect(restored.files[0]?.reviewed).toBe(true);
  const otherTask = available(await owner.getReview({ ...input, target: secondTask }));
  expect(otherTask.files[0]?.reviewed).toBe(false);

  await writeFile(join(checkoutPath, "example.txt"), "later\n");
  await expect(
    owner.getReviewFile({ reviewId: first.reviewId, fileId: file.id }),
  ).resolves.toMatchObject({ state: "stale" });
  await expect(
    owner.setReviewFileReviewed({ reviewId: first.reviewId, fileId: file.id, reviewed: true }),
  ).resolves.toMatchObject({ state: "stale" });
  const changed = available(await owner.getReview(input));
  expect(changed.files[0]?.reviewed).toBe(false);
});

test("staging and unstaging keep a reviewed mark until the content changes", async () => {
  const { checkoutPath, owner } = await fixture();
  const input = {
    target: firstTask,
    checkoutId: "checkout",
    scope: { kind: "uncommitted" as const },
  };
  const reviewedFile = async () => {
    const review = available(await owner.getReview(input));
    const file = review.files.find((entry) => entry.path === "example.txt");
    if (!file) throw new Error("Expected changed example.txt");
    return { review, file };
  };
  const first = await reviewedFile();
  await owner.setReviewFileReviewed({
    reviewId: first.review.reviewId,
    fileId: first.file.id,
    reviewed: true,
  });
  await expect(
    owner.changeReviewFileStage({
      reviewId: first.review.reviewId,
      fileId: first.file.id,
      action: "stage",
    }),
  ).resolves.toEqual({ state: "applied" });
  const staged = await reviewedFile();
  expect(staged.file).toMatchObject({ hasStagedChanges: true, reviewed: true });
  await expect(
    owner.changeReviewFileStage({
      reviewId: staged.review.reviewId,
      fileId: staged.file.id,
      action: "unstage",
    }),
  ).resolves.toEqual({ state: "applied" });
  expect((await reviewedFile()).file).toMatchObject({ hasStagedChanges: false, reviewed: true });

  await writeFile(join(checkoutPath, "example.txt"), "edited after review\n");
  expect((await reviewedFile()).file.reviewed).toBe(false);
});

test("expired, removed-task and remapped-checkout comparisons never target the current task", async () => {
  const { options } = await fixture();
  let valid = true;
  let path = options.resolveCheckoutPath("checkout");
  const owner = new ReviewOwner({
    ...options,
    validateTask: () => valid,
    resolveCheckoutPath: () => path,
  });
  await expect(
    owner.getReviewFile({ reviewId: "unknown", fileId: "unknown" }),
  ).resolves.toMatchObject({ state: "unavailable", code: "review-expired" });
  const review = available(
    await owner.getReview({
      target: firstTask,
      checkoutId: "checkout",
      scope: { kind: "uncommitted" },
    }),
  );
  const file = review.files[0];
  if (!file) throw new Error("Expected changed file");
  valid = false;
  await expect(
    owner.getReviewFile({ reviewId: review.reviewId, fileId: file.id }),
  ).resolves.toMatchObject({ state: "unavailable", code: "task-unavailable" });
  valid = true;
  path = await mkdtemp(join(tmpdir(), "pi-gui-review-other-checkout-"));
  await expect(
    owner.changeReviewFileStage({ reviewId: review.reviewId, fileId: file.id, action: "stage" }),
  ).resolves.toMatchObject({ state: "stale", code: "checkout-changed" });
});

test("missing captured history is unavailable and a supplied checkpoint stays explicitly pinned", async () => {
  const { checkoutPath, options, owner } = await fixture();
  const input = { target: firstTask, checkoutId: "checkout", scope: { kind: "turn" as const } };
  await expect(owner.getReview(input)).resolves.toMatchObject({
    state: "unavailable",
    code: "checkpoint-unavailable",
  });
  await expect(
    owner.resolveTurnReview({ target: firstTask, messageId: "old-message" }),
  ).resolves.toMatchObject({ state: "unavailable", code: "checkpoint-unavailable" });
  const beforeTreeOid = await git(checkoutPath, ["rev-parse", "HEAD^{tree}"]);
  await git(checkoutPath, ["add", "example.txt"]);
  await git(checkoutPath, ["commit", "-m", "after"]);
  const afterTreeOid = await git(checkoutPath, ["rev-parse", "HEAD^{tree}"]);
  const requests: unknown[] = [];
  const checkpoints: ReviewCheckpointSource = {
    async resolveTurn(request) {
      return request.messageId === "captured-message"
        ? { state: "available", checkpointId: "captured-turn" }
        : {
            state: "unavailable",
            code: "checkpoint-unavailable",
            message: "No capture exists for this exact message.",
          };
    },
    async resolve(request) {
      requests.push(request);
      return {
        state: "available",
        checkpointId: "captured-turn",
        checkoutId: "checkout",
        repositoryPath: checkoutPath,
        beforeTreeOid,
        afterTreeOid,
        capturedAt: "2026-09-22T12:00:00.000Z",
        coverage: { state: "complete", notes: [] },
      };
    },
  };
  const capturedOwner = new ReviewOwner({
    ...options,
    // The original checkout can disappear while the app-owned capture repository remains.
    resolveCheckoutPath: () => undefined,
    checkpoints,
  });
  await expect(
    capturedOwner.resolveTurnReview({ target: firstTask, messageId: "captured-message" }),
  ).resolves.toEqual({ state: "available", checkpointId: "captured-turn" });
  await expect(
    capturedOwner.resolveTurnReview({ target: firstTask, messageId: "old-message" }),
  ).resolves.toMatchObject({ state: "unavailable", code: "checkpoint-unavailable" });
  const result = available(await capturedOwner.getReview(input));
  expect(result.scope).toEqual({ kind: "turn", checkpointId: "captured-turn" });
  expect(result.capturedAt).toBe("2026-09-22T12:00:00.000Z");
  expect(requests).toEqual([{ target: firstTask, checkoutId: "checkout" }]);
  const file = result.files[0];
  if (!file) throw new Error("Expected captured file");
  await expect(
    capturedOwner.changeReviewFileStage({
      reviewId: result.reviewId,
      fileId: file.id,
      action: "stage",
    }),
  ).resolves.toMatchObject({ state: "unavailable", code: "read-only-comparison" });
});

test("review metadata serializes concurrent acknowledgements and preserves invalid bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-gui-reviewed-store-"));
  const store = new ReviewedStore(dir);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  await Promise.all([store.set(first, true), store.set(second, true)]);
  expect(await new ReviewedStore(dir).snapshot()).toEqual(new Set([first, second]));
  await store.set(first, false);
  expect(await new ReviewedStore(dir).snapshot()).toEqual(new Set([second]));

  const invalidDir = await mkdtemp(join(tmpdir(), "pi-gui-reviewed-invalid-"));
  const path = join(invalidDir, "reviewed-files.json");
  const original = '{"version":99,"marks":[],"future":"retain"}\n';
  await writeFile(path, original);
  const invalid = new ReviewedStore(invalidDir);
  await expect(invalid.snapshot()).rejects.toThrow("unsupported");
  await expect(invalid.set(first, true)).rejects.toThrow("unsupported");
  expect(await readFile(path, "utf8")).toBe(original);

  // A failed read is not cached: once the file is readable again, marks work without a restart.
  await writeFile(path, `${JSON.stringify({ version: 1, marks: [second] })}\n`);
  expect(await invalid.snapshot()).toEqual(new Set([second]));
  await invalid.set(first, true);
  expect(await new ReviewedStore(invalidDir).snapshot()).toEqual(new Set([first, second]));
});
