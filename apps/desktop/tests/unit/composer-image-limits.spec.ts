import { expect, test } from "@playwright/test";
import {
  acceptComposerAttachments,
  assertComposerImageBytes,
  assertComposerImagePixels,
  COMPOSER_IMAGE_MAX_BYTES,
  COMPOSER_IMAGE_MAX_BYTES_TOTAL,
  COMPOSER_IMAGE_MAX_DIMENSION,
  composerImageAggregateLimitMessage,
  composerImageBytesLimitMessage,
  composerImagePixelsLimitMessage,
  decodedImageByteLength,
  quarantineComposerAttachments,
} from "../../contracts/composer-attachments";
import type { ComposerAttachment } from "../../contracts/desktop-state";
import { TINY_PNG_BASE64 } from "../helpers/electron-app";
import { expectComposerAttachments } from "../../electron/ipc/request-validation";

function imageAttachment(data: string, id = "image"): ComposerAttachment {
  return {
    id,
    kind: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    data,
  };
}

function fileAttachment(id = "notes"): ComposerAttachment {
  return {
    id,
    kind: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    fsPath: `/tmp/${id}.txt`,
    sizeBytes: 12,
  };
}

const oversizedData = Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1).toString("base64");
const maxData = Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES, 1).toString("base64");

test("decoded image byte length matches the original payload", () => {
  expect(decodedImageByteLength(TINY_PNG_BASE64)).toBe(
    Buffer.from(TINY_PNG_BASE64, "base64").length,
  );
  expect(decodedImageByteLength(oversizedData)).toBe(COMPOSER_IMAGE_MAX_BYTES + 1);
});

test("per-image and pixel caps reject oversize and allow the inclusive bound", () => {
  expect(() => assertComposerImageBytes(COMPOSER_IMAGE_MAX_BYTES)).not.toThrow();
  expect(() => assertComposerImageBytes(COMPOSER_IMAGE_MAX_BYTES + 1)).toThrow(
    composerImageBytesLimitMessage(),
  );
  expect(() =>
    assertComposerImagePixels(COMPOSER_IMAGE_MAX_DIMENSION, COMPOSER_IMAGE_MAX_DIMENSION),
  ).not.toThrow();
  expect(() => assertComposerImagePixels(COMPOSER_IMAGE_MAX_DIMENSION + 1, 1)).toThrow(
    composerImagePixelsLimitMessage(),
  );
});

test("accept enforces per-image and aggregate limits and ignores file attachments", () => {
  const tiny = imageAttachment(TINY_PNG_BASE64, "tiny");
  const file = fileAttachment();
  const oversized = imageAttachment(oversizedData, "huge");
  expect(acceptComposerAttachments([], [tiny, file])).toEqual({
    ok: true,
    attachments: [tiny, file],
  });
  const oversizedResult = acceptComposerAttachments([], [oversized]);
  expect(oversizedResult.ok).toBe(false);
  if (!oversizedResult.ok) {
    expect(oversizedResult.error.message).toBe(composerImageBytesLimitMessage());
  }

  const maxImage = imageAttachment(maxData, "max");
  const acceptedTwo = acceptComposerAttachments(
    [maxImage],
    [maxImage, imageAttachment(maxData, "third")],
  );
  expect(acceptedTwo.ok).toBe(true);

  const rejected = acceptComposerAttachments(
    [maxImage, imageAttachment(maxData, "two"), imageAttachment(maxData, "three")],
    [imageAttachment(maxData, "four")],
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) {
    expect(rejected.error.message).toBe(composerImageAggregateLimitMessage());
  }
  expect(COMPOSER_IMAGE_MAX_BYTES_TOTAL).toBe(3 * COMPOSER_IMAGE_MAX_BYTES);
});

test("quarantine skips oversized saved images without dropping files or valid siblings", () => {
  const tiny = imageAttachment(TINY_PNG_BASE64, "tiny");
  const huge = imageAttachment(oversizedData, "huge");
  const file = fileAttachment();
  expect(quarantineComposerAttachments([tiny, huge, file])).toEqual({
    kept: [tiny, file],
    skipped: 1,
  });
});

test("IPC attachment validation rejects oversized decoded payloads", () => {
  expect(() =>
    expectComposerAttachments([
      {
        id: "huge",
        kind: "image",
        name: "huge.png",
        mimeType: "image/png",
        data: oversizedData,
      },
    ]),
  ).toThrow(composerImageBytesLimitMessage());

  const trusted = expectComposerAttachments([
    {
      id: " tiny ",
      kind: "image",
      name: " screenshot.png ",
      mimeType: " image/png ",
      data: ` ${TINY_PNG_BASE64} `,
      extra: true,
    },
  ]);
  expect(trusted).toEqual([
    {
      id: "tiny",
      kind: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      data: TINY_PNG_BASE64,
    },
  ]);
});
