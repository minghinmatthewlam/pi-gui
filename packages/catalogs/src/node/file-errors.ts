export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
