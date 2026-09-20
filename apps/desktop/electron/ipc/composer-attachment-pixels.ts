import { nativeImage } from "electron";
import {
  assertComposerImagePixels,
  composerImagePixelsLimitError,
  quarantineComposerAttachments,
} from "../../contracts/composer-attachments";
import type { ComposerAttachment } from "../../contracts/desktop-state";

function nativeImageSize(
  attachment: ComposerAttachment,
): { readonly width: number; readonly height: number } | undefined {
  if (attachment.kind !== "image") {
    return undefined;
  }
  const image = nativeImage.createFromBuffer(Buffer.from(attachment.data, "base64"));
  if (image.isEmpty()) {
    return undefined;
  }
  return image.getSize();
}

export function assertComposerAttachmentPixels(attachments: readonly ComposerAttachment[]): void {
  for (const attachment of attachments) {
    const size = nativeImageSize(attachment);
    if (!size) {
      continue;
    }
    assertComposerImagePixels(size.width, size.height);
  }
}

export function quarantinePersistedComposerAttachments(
  attachments: readonly ComposerAttachment[],
): {
  readonly kept: ComposerAttachment[];
  readonly skipped: number;
} {
  const { kept: byteKept, skipped: byteSkipped } = quarantineComposerAttachments(attachments);
  const kept: ComposerAttachment[] = [];
  let skipped = byteSkipped;
  for (const attachment of byteKept) {
    const size = nativeImageSize(attachment);
    if (size && composerImagePixelsLimitError(size.width, size.height)) {
      skipped += 1;
      continue;
    }
    kept.push(attachment);
  }
  return { kept, skipped };
}
