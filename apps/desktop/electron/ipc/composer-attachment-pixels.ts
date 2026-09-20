import { nativeImage } from "electron";
import { assertComposerImagePixels } from "../../contracts/composer-attachments";
import type { ComposerAttachment } from "../../contracts/desktop-state";

export function assertComposerAttachmentPixels(attachments: readonly ComposerAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      continue;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(attachment.data, "base64"));
    if (image.isEmpty()) {
      continue;
    }
    const { width, height } = image.getSize();
    assertComposerImagePixels(width, height);
  }
}
