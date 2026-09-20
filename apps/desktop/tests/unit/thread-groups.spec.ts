import { expect, test } from "@playwright/test";
import {
  WORKSPACE_HISTORY_PREVIEW_LIMIT,
  workspaceHistoryList,
} from "../../src/features/threads/thread-groups";

test("keeps workspace history lists at five threads until they overflow", () => {
  const threads = ["one", "two", "three", "four", "five", "six", "seven"];
  expect(WORKSPACE_HISTORY_PREVIEW_LIMIT).toBe(5);

  const empty = workspaceHistoryList([], false);
  expect(empty).toEqual({ visible: [], overflow: false });

  const atLimit = workspaceHistoryList(threads.slice(0, 5), true);
  expect(atLimit.overflow).toBe(false);
  expect(atLimit.visible).toEqual(["one", "two", "three", "four", "five"]);

  const collapsed = workspaceHistoryList(threads, false);
  expect(collapsed.overflow).toBe(true);
  expect(collapsed.visible).toEqual(["one", "two", "three", "four", "five"]);

  const expanded = workspaceHistoryList(threads, true);
  expect(expanded.overflow).toBe(true);
  expect(expanded.visible).toEqual(threads);
});
