/// <reference lib="dom" />

import type { ComposerImageAttachment } from "./desktop-state";

export const SUPPORTED_COMPOSER_IMAGE_TYPES = [
  { extension: "png", mimeType: "image/png" },
  { extension: "jpg", mimeType: "image/jpeg" },
  { extension: "jpeg", mimeType: "image/jpeg" },
  { extension: "gif", mimeType: "image/gif" },
  { extension: "webp", mimeType: "image/webp" },
] as const;

type ComposerImageMimeType = (typeof SUPPORTED_COMPOSER_IMAGE_TYPES)[number]["mimeType"];

const SUPPORTED_COMPOSER_IMAGE_MIME_TYPES = new Set(SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType));
export const COMPOSER_IMAGE_FILE_INPUT_ACCEPT = SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType).join(",");

function isImageFile(file: Pick<File, "type">): boolean {
  return SUPPORTED_COMPOSER_IMAGE_MIME_TYPES.has(file.type as ComposerImageMimeType);
}

function fileSignature(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

function dedupeFiles(files: readonly File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const signature = fileSignature(file);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    unique.push(file);
  }
  return unique;
}

export function extractImageFilesFromClipboardData(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) {
    return [];
  }

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file" && isImageFile(item))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .filter(isImageFile);
  const clipboardFiles = Array.from(clipboardData.files ?? []).filter(isImageFile);
  return dedupeFiles([...itemFiles, ...clipboardFiles]);
}

export function extractImageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files).filter(isImageFile);
}

export async function readComposerAttachmentsFromFiles(files: readonly File[]): Promise<ComposerImageAttachment[]> {
  const supportedFiles = files.filter(isImageFile);
  const attachments = await Promise.all(
    supportedFiles.map(
      (file) =>
        new Promise<ComposerImageAttachment | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const commaIndex = dataUrl.indexOf(",");
            resolve({
              id: crypto.randomUUID(),
              name: file.name || "pasted-image.png",
              mimeType: file.type || "image/png",
              data: dataUrl.slice(commaIndex + 1),
            });
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        }),
    ),
  );

  return attachments.filter((attachment): attachment is ComposerImageAttachment => Boolean(attachment));
}
