import { expect, test } from "@playwright/test";
import {
  RendererErrorBoundary,
  rendererBoundaryCopy,
  startupSurfaceCopy,
} from "../../src/app/desktop-recovery";

const SENTINEL = "secret-token=/private/path";

test("startup copy switches on failure codes and never interpolates error text", () => {
  expect(startupSurfaceCopy({ kind: "loading" })).toEqual({
    title: "Loading sessions",
    body: "The desktop shell is restoring folder and thread state from the main process.",
    status: "loading",
  });
  expect(
    startupSurfaceCopy({
      kind: "failed",
      failure: { code: "state-request-failed" },
      retrying: false,
    }),
  ).toEqual({
    title: "Couldn't restore sessions",
    body: "The desktop shell couldn't read folder and thread state. Retry, or relaunch the app.",
    status: "failed",
  });
  expect(
    startupSurfaceCopy({
      kind: "failed",
      failure: { code: "bridge-unavailable" },
      retrying: true,
    }).body,
  ).toContain("Quit pi-gui and reopen it");
  expect(JSON.stringify(startupSurfaceCopy({ kind: "crashed" }))).not.toContain(SENTINEL);
});

test("error boundary derived state stores no thrown details", () => {
  const next = RendererErrorBoundary.getDerivedStateFromError(new Error(SENTINEL));
  expect(next).toEqual({ hasError: true });
  expect(JSON.stringify(next)).not.toContain("secret");
  expect(JSON.stringify(next)).not.toContain("/private/path");
});

test("crash fallback copy stays generic", () => {
  const copy = rendererBoundaryCopy();
  expect(copy.title).toBe("Something went wrong");
  expect(copy.status).toBe("crashed");
  expect(JSON.stringify(copy)).not.toContain(SENTINEL);
});
