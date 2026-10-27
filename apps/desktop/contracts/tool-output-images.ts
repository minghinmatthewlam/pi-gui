/**
 * Images a tool returned in its result content. pi stores each as an `{ type: "image", data,
 * mimeType }` block. Main keeps the data and gives the window a `pi-gui-image://` URL for each
 * image it can show. A tool row shows no other image source, so a tool result's image blocks can't
 * make it load a remote or local file.
 */

/** Scheme main serves tool-output images on, so their data isn't sent with the transcript. */
export const TOOL_IMAGE_SCHEME = "pi-gui-image";

const SHOWN_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Any image block in a tool result, shown or not. */
export function isToolImageBlock(value: unknown): value is { type: "image"; mimeType?: unknown } {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image"
  );
}

/** An image block as pi stores it, with data of a type the window shows. */
export function isShownToolImageData(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  if (!isToolImageBlock(value)) return false;
  const { data, mimeType } = value as Record<string, unknown>;
  return (
    typeof data === "string" && typeof mimeType === "string" && SHOWN_IMAGE_TYPES.has(mimeType)
  );
}

/** An image block as main sends it to the window, pointing at main's own image URL. */
export function isShownToolImageUrl(
  value: unknown,
): value is { type: "image"; src: string; mimeType: string } {
  if (!isToolImageBlock(value)) return false;
  const { src, mimeType } = value as Record<string, unknown>;
  return (
    typeof src === "string" &&
    src.startsWith(`${TOOL_IMAGE_SCHEME}://`) &&
    typeof mimeType === "string" &&
    SHOWN_IMAGE_TYPES.has(mimeType)
  );
}
