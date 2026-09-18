/// <reference lib="dom" />

import type { KeyboardEvent } from "react";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "./desktop-state";

export function handleClipboardImageShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  readClipboardImage: (() => ComposerImageAttachment | null) | undefined,
  onImage: (attachment: ComposerImageAttachment) => void,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "v") {
    return false;
  }

  const clipboardImage = readClipboardImage?.();
  if (!clipboardImage) {
    return false;
  }

  event.preventDefault();
  onImage(clipboardImage);
  return true;
}

export const SUPPORTED_COMPOSER_IMAGE_TYPES = [
  { extension: "png", mimeType: "image/png" },
  { extension: "jpg", mimeType: "image/jpeg" },
  { extension: "jpeg", mimeType: "image/jpeg" },
  { extension: "gif", mimeType: "image/gif" },
  { extension: "webp", mimeType: "image/webp" },
] as const;

type ComposerImageMimeType = (typeof SUPPORTED_COMPOSER_IMAGE_TYPES)[number]["mimeType"];
type FileWithPath = File & { readonly path?: string };

const SUPPORTED_COMPOSER_IMAGE_MIME_TYPES = new Set(
  SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType),
);
const IMAGE_MIME_TYPE_BY_EXTENSION = new Map(
  SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => [type.extension, type.mimeType] as const),
);

function inferImageMimeType(file: Pick<File, "name" | "type">): ComposerImageMimeType | undefined {
  if (SUPPORTED_COMPOSER_IMAGE_MIME_TYPES.has(file.type as ComposerImageMimeType)) {
    return file.type as ComposerImageMimeType;
  }

  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  if (!extension) {
    return undefined;
  }

  return IMAGE_MIME_TYPE_BY_EXTENSION.get(
    extension as (typeof SUPPORTED_COMPOSER_IMAGE_TYPES)[number]["extension"],
  );
}

function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return Boolean(inferImageMimeType(file));
}

function fileSignature(file: FileWithPath): string {
  return `${file.path ?? ""}:${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

function dedupeFiles(files: readonly File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const signature = fileSignature(file as FileWithPath);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    unique.push(file);
  }
  return unique;
}

export function hasFilesInDataTransfer(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes("Files")) {
    return true;
  }

  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")) {
    return true;
  }

  return (dataTransfer.files?.length ?? 0) > 0;
}

export function extractImageFilesFromClipboardData(
  clipboardData: DataTransfer | null | undefined,
): File[] {
  if (!clipboardData) {
    return [];
  }

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .filter(isImageFile);
  const clipboardFiles = Array.from(clipboardData.files ?? []).filter(isImageFile);
  return dedupeFiles([...itemFiles, ...clipboardFiles]);
}

export function extractFilesFromDataTransfer(
  dataTransfer: DataTransfer | null | undefined,
): File[] {
  if (!dataTransfer) {
    return [];
  }

  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const transferFiles = Array.from(dataTransfer.files ?? []);
  return dedupeFiles([...itemFiles, ...transferFiles]);
}

export async function readComposerAttachmentsFromFiles(
  files: readonly File[],
): Promise<ComposerAttachment[]> {
  const attachments = await Promise.all(dedupeFiles(files).map(readComposerAttachmentFromFile));
  return attachments.filter((attachment): attachment is ComposerAttachment => Boolean(attachment));
}

async function readComposerAttachmentFromFile(file: File): Promise<ComposerAttachment | null> {
  if (isImageFile(file)) {
    return readImageAttachmentFromFile(file);
  }

  return readFileAttachmentFromFile(file as FileWithPath);
}

function readImageAttachmentFromFile(file: File): Promise<ComposerImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIndex = dataUrl.indexOf(",");
      resolve({
        id: crypto.randomUUID(),
        kind: "image",
        name: file.name || "pasted-image.png",
        mimeType: inferImageMimeType(file) ?? "image/png",
        data: dataUrl.slice(commaIndex + 1),
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readFileAttachmentFromFile(file: FileWithPath): ComposerFileAttachment | null {
  const fsPath = resolveFilePath(file);
  if (!fsPath) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    kind: "file",
    name: file.name || fileNameFromPath(fsPath) || "attached-file",
    mimeType: file.type || "application/octet-stream",
    fsPath,
    ...(typeof file.size === "number" ? { sizeBytes: file.size } : {}),
  };
}

function resolveFilePath(file: FileWithPath): string | null {
  const directPath = file.path?.trim();
  if (directPath) {
    return directPath;
  }

  const bridgePath = window.piApp?.getPathForFile?.(file)?.trim();
  return bridgePath || null;
}

function fileNameFromPath(filePath: string): string {
  const segments = filePath.split(/[/\\]+/);
  return segments[segments.length - 1] ?? "";
}
