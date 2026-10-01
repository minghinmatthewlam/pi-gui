/**
 * Images a tool returned in its result content, such as the read tool on a screenshot or a code
 * mode script calling `image()` with `models.generateImages()`. pi keeps them as
 * `{ type: "image", data, mimeType }` blocks in the result's `content`, live and after reload.
 */
export interface ToolOutputImage {
  readonly data: string;
  readonly mimeType: string;
}

/** Only these become data: URLs; anything else is left as text. */
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isImageBlock(
  value: unknown,
): value is { type: "image"; data: string; mimeType?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Record<string, unknown>;
  return block.type === "image" && typeof block.data === "string";
}

function isShownImage(value: unknown): value is { type: "image" } & ToolOutputImage {
  return (
    isImageBlock(value) &&
    typeof value.mimeType === "string" &&
    IMAGE_MIME_TYPES.has(value.mimeType)
  );
}

export function toolOutputImages(output: unknown): readonly ToolOutputImage[] {
  if (typeof output !== "object" || output === null) return [];
  const { content } = output as Record<string, unknown>;
  if (!Array.isArray(content)) return [];
  return content.filter(isShownImage).map(({ data, mimeType }) => ({ data, mimeType }));
}

export function toolOutputImageSrc(image: ToolOutputImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** JSON for the expanded row and Copy, with image data shown as a short placeholder. */
export function stringifyToolValue(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nested: unknown) =>
      isImageBlock(nested)
        ? {
            ...nested,
            data: `[${typeof nested.mimeType === "string" ? nested.mimeType : "image"} image]`,
          }
        : nested,
    2,
  );
}
