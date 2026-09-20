/// <reference lib="dom" />

import { type KeyboardEvent } from "react";
import {
  assertComposerAttachmentsAccepted,
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
  decodedImageByteLength,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  type ClipboardImageRead,
} from "../../../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../../contracts/desktop-state";

export function handleClipboardImageShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  readClipboardImage: (() => ClipboardImageRead) | undefined,
  onImage: (attachment: ComposerImageAttachment) => void,
  onError?: (message: string) => void,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "v") {
    return false;
  }

  const clipboardImage = readClipboardImage?.();
  if (!clipboardImage) {
    return false;
  }
  if (clipboardImage.ok) {
    event.preventDefault();
    onImage(clipboardImage.attachment);
    return true;
  }
  if (clipboardImage.message) {
    event.preventDefault();
    onError?.(clipboardImage.message);
    return true;
  }
  return false;
}

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
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const unique = dedupeFiles(files);
  const imageFiles = unique.filter(isImageFile);
  assertComposerImageFileSizes(
    imageFiles.map((file) => file.size),
    existing,
  );

  const attachments = await Promise.all(unique.map(readComposerAttachmentFromFile));
  const drafted = attachments.filter((attachment): attachment is ComposerAttachment =>
    Boolean(attachment),
  );
  return [...assertComposerAttachmentsAccepted(existing, drafted)];
}

async function readComposerAttachmentFromFile(file: File): Promise<ComposerAttachment | null> {
  if (isImageFile(file)) {
    return readImageAttachmentFromFile(file);
  }

  return readFileAttachmentFromFile(file as FileWithPath);
}

async function readImageAttachmentFromFile(file: File): Promise<ComposerImageAttachment | null> {
  assertComposerImageBytes(file.size);
  const dataUrl = await readFileAsDataUrl(file);
  if (dataUrl === null) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  const data = dataUrl.slice(commaIndex + 1);
  assertComposerImageBytes(decodedImageByteLength(data));
  const dimensions = await readImageDimensions(dataUrl);
  if (dimensions) {
    assertComposerImagePixels(dimensions.width, dimensions.height);
  }
  return {
    id: crypto.randomUUID(),
    kind: "image",
    name: file.name || "pasted-image.png",
    mimeType: inferImageMimeType(file) ?? "image/png",
    data,
  };
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(
  dataUrl: string,
): Promise<{ readonly width: number; readonly height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
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
