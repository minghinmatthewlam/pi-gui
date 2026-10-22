import { expect, test } from "@playwright/test";
import type { ClipboardEvent, KeyboardEvent } from "react";
import type { ClipboardImageRead } from "../../contracts/composer-attachments";
import type { ComposerImageAttachment } from "../../contracts/desktop-state";
import {
  handleClipboardImageShortcut,
  handleComposerImagePaste,
} from "../../src/features/conversation/composer-attachments";

const IMAGE: ComposerImageAttachment = {
  id: "image-1",
  kind: "image",
  name: "pasted-image.png",
  mimeType: "image/png",
  data: "AAAA",
};

function pasteKey(overrides: Partial<KeyboardEvent<HTMLTextAreaElement>> = {}) {
  return {
    key: "v",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent<HTMLTextAreaElement>;
}

function pasteWith(result: ClipboardImageRead, beforeSettle?: () => void) {
  const images: ComposerImageAttachment[] = [];
  const errors: string[] = [];
  handleClipboardImageShortcut(
    pasteKey(),
    async () => result,
    (image) => images.push(image),
    (message) => errors.push(message),
  );
  beforeSettle?.();
  return { images, errors };
}

test("the paste shortcut attaches the image the native clipboard read returns", async () => {
  const paste = pasteWith({ ok: true, attachment: IMAGE });
  await expect.poll(() => paste.images).toEqual([IMAGE]);
  expect(paste.errors).toEqual([]);
});

test("the paste shortcut reports a clipboard image the composer cannot accept", async () => {
  const paste = pasteWith({ ok: false, message: "Image is too large" });
  await expect.poll(() => paste.errors).toEqual(["Image is too large"]);
  expect(paste.images).toEqual([]);
});

function imagePasteEvent() {
  const file = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  let prevented = false;
  const event = {
    clipboardData: { items: [], files: [file], types: ["Files"] },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as ClipboardEvent<HTMLElement>;
  return { event, file, prevented: () => prevented };
}

test("the native image wins over the image files of the paste event it races", async () => {
  const pasted: File[][] = [];
  const paste = pasteWith({ ok: true, attachment: IMAGE }, () => {
    const dom = imagePasteEvent();
    handleComposerImagePaste(dom.event, (files) => pasted.push(files));
    expect(dom.prevented()).toBe(true);
  });
  await expect.poll(() => paste.images).toEqual([IMAGE]);
  expect(pasted).toEqual([]);
});

test("the paste event's image files attach when the native clipboard has no image", async () => {
  const pasted: File[][] = [];
  const dom = imagePasteEvent();
  pasteWith({ ok: false }, () => {
    handleComposerImagePaste(dom.event, (files) => pasted.push(files));
  });
  await expect.poll(() => pasted).toEqual([[dom.file]]);
});

test("a paste without the shortcut attaches the event's image files at once", () => {
  const pasted: File[][] = [];
  const dom = imagePasteEvent();
  handleComposerImagePaste(dom.event, (files) => pasted.push(files));
  expect(pasted).toEqual([[dom.file]]);
  expect(dom.prevented()).toBe(true);
});

test("only the plain paste chord reads the native clipboard", () => {
  let reads = 0;
  const read = async (): Promise<ClipboardImageRead> => {
    reads += 1;
    return { ok: false };
  };
  handleClipboardImageShortcut(pasteKey({ shiftKey: true }), read, () => undefined);
  handleClipboardImageShortcut(pasteKey({ ctrlKey: false }), read, () => undefined);
  handleClipboardImageShortcut(pasteKey({ key: "c" }), read, () => undefined);
  expect(reads).toBe(0);
});
