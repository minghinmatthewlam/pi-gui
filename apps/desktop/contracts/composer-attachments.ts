import type { ComposerAttachment, ComposerImageAttachment } from "./desktop-state";

export const SUPPORTED_COMPOSER_IMAGE_TYPES = [
  { extension: "png", mimeType: "image/png" },
  { extension: "jpg", mimeType: "image/jpeg" },
  { extension: "jpeg", mimeType: "image/jpeg" },
  { extension: "gif", mimeType: "image/gif" },
  { extension: "webp", mimeType: "image/webp" },
] as const;

/** Decoded image file bytes (PNG/JPEG/GIF/WebP payload, not bitmap pixels). */
export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const COMPOSER_IMAGE_MAX_DIMENSION = 8_192;
/** Sum of decoded image payloads on one composer. File attachments do not count. */
export const COMPOSER_IMAGE_MAX_BYTES_TOTAL = 3 * COMPOSER_IMAGE_MAX_BYTES;

export type ComposerAttachmentLimitCode = "bytes" | "pixels" | "aggregate";

export class ComposerAttachmentLimitError extends Error {
  readonly code: ComposerAttachmentLimitCode;

  constructor(code: ComposerAttachmentLimitCode, message: string) {
    super(message);
    this.name = "ComposerAttachmentLimitError";
    this.code = code;
  }
}

export type ComposerAttachmentAcceptResult =
  | { readonly ok: true; readonly attachments: readonly ComposerAttachment[] }
  | { readonly ok: false; readonly error: ComposerAttachmentLimitError };

export type ClipboardImageRead =
  | { readonly ok: true; readonly attachment: ComposerImageAttachment }
  | { readonly ok: false; readonly message?: string };

export function decodedImageByteLength(base64: string): number {
  const trimmed = base64.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export function totalComposerImageBytes(attachments: readonly ComposerAttachment[]): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind !== "image") {
      return total;
    }
    return total + decodedImageByteLength(attachment.data);
  }, 0);
}

export function composerImageBytesLimitMessage(): string {
  return `Image is larger than ${formatMegabytes(COMPOSER_IMAGE_MAX_BYTES)} MB.`;
}

export function composerImagePixelsLimitMessage(): string {
  return `Image is larger than ${COMPOSER_IMAGE_MAX_DIMENSION} pixels.`;
}

export function composerImageAggregateLimitMessage(): string {
  return `Images together are larger than ${formatMegabytes(COMPOSER_IMAGE_MAX_BYTES_TOTAL)} MB.`;
}

export function composerImageSavedSkipMessage(skipped: number): string {
  if (skipped === 1) {
    return "Skipped an oversized saved image.";
  }
  return `Skipped ${skipped} oversized saved images.`;
}

export function composerImageBytesLimitError(
  decodedBytes: number,
): ComposerAttachmentLimitError | undefined {
  if (decodedBytes > COMPOSER_IMAGE_MAX_BYTES) {
    return new ComposerAttachmentLimitError("bytes", composerImageBytesLimitMessage());
  }
  return undefined;
}

export function composerImagePixelsLimitError(
  width: number,
  height: number,
): ComposerAttachmentLimitError | undefined {
  if (width > COMPOSER_IMAGE_MAX_DIMENSION || height > COMPOSER_IMAGE_MAX_DIMENSION) {
    return new ComposerAttachmentLimitError("pixels", composerImagePixelsLimitMessage());
  }
  return undefined;
}

export function composerImageAggregateLimitError(
  totalDecodedBytes: number,
): ComposerAttachmentLimitError | undefined {
  if (totalDecodedBytes > COMPOSER_IMAGE_MAX_BYTES_TOTAL) {
    return new ComposerAttachmentLimitError("aggregate", composerImageAggregateLimitMessage());
  }
  return undefined;
}

export function assertComposerImageBytes(decodedBytes: number): void {
  const error = composerImageBytesLimitError(decodedBytes);
  if (error) {
    throw error;
  }
}

export function assertComposerImagePixels(width: number, height: number): void {
  const error = composerImagePixelsLimitError(width, height);
  if (error) {
    throw error;
  }
}

export function acceptComposerAttachments(
  existing: readonly ComposerAttachment[],
  incoming: readonly ComposerAttachment[],
): ComposerAttachmentAcceptResult {
  const existingBytes = totalComposerImageBytes(existing);
  let incomingBytes = 0;
  for (const attachment of incoming) {
    if (attachment.kind !== "image") {
      continue;
    }
    const bytes = decodedImageByteLength(attachment.data);
    const perImage = composerImageBytesLimitError(bytes);
    if (perImage) {
      return { ok: false, error: perImage };
    }
    incomingBytes += bytes;
  }
  const aggregate = composerImageAggregateLimitError(existingBytes + incomingBytes);
  if (aggregate) {
    return { ok: false, error: aggregate };
  }
  return { ok: true, attachments: incoming };
}

export function assertComposerAttachmentsAccepted(
  existing: readonly ComposerAttachment[],
  incoming: readonly ComposerAttachment[],
): readonly ComposerAttachment[] {
  const result = acceptComposerAttachments(existing, incoming);
  if (!result.ok) {
    throw result.error;
  }
  return result.attachments;
}

export function quarantineComposerAttachments(attachments: readonly ComposerAttachment[]): {
  readonly kept: ComposerAttachment[];
  readonly skipped: number;
} {
  const kept: ComposerAttachment[] = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      kept.push(attachment);
      continue;
    }
    const bytes = decodedImageByteLength(attachment.data);
    if (
      composerImageBytesLimitError(bytes) ||
      composerImageAggregateLimitError(totalBytes + bytes)
    ) {
      skipped += 1;
      continue;
    }
    totalBytes += bytes;
    kept.push(attachment);
  }
  return { kept, skipped };
}

function formatMegabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}
