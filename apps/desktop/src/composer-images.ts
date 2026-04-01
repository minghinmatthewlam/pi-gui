/// <reference lib="dom" />

import type { ComposerImageAttachment } from "./desktop-state";

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
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
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
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
  const attachments = await Promise.all(
    files.map(
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
