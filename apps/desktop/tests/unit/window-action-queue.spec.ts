import { expect, test } from "@playwright/test";
import { SerializedActionQueue } from "../../electron/windows/action-queue";

test("window actions remain serialized after a failed action", async () => {
  const queue = new SerializedActionQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;

  const first = queue.run(
    () =>
      new Promise<void>((resolve) => {
        events.push("first:start");
        releaseFirst = () => {
          events.push("first:end");
          resolve();
        };
      }),
  );
  const second = queue.run(async () => {
    events.push("second");
    throw new Error("expected failure");
  });
  const third = queue.run(async () => {
    events.push("third");
  });

  await expect.poll(() => events).toEqual(["first:start"]);
  releaseFirst?.();
  await first;
  await expect(second).rejects.toThrow("expected failure");
  await third;
  expect(events).toEqual(["first:start", "first:end", "second", "third"]);
});

test("an immediate cancellation is not forced through the window action queue", async () => {
  const queue = new SerializedActionQueue();
  let releaseSubmittedPrompt: (() => void) | undefined;
  const events: string[] = [];

  const submittedPrompt = queue.run(
    () =>
      new Promise<void>((resolve) => {
        events.push("prompt:start");
        releaseSubmittedPrompt = resolve;
      }),
  );
  await expect.poll(() => events).toEqual(["prompt:start"]);

  const cancelImmediately = async () => {
    events.push("cancel");
    releaseSubmittedPrompt?.();
  };
  await cancelImmediately();
  await submittedPrompt;

  expect(events).toEqual(["prompt:start", "cancel"]);
});
