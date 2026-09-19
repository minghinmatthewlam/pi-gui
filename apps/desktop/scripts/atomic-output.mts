import { rename } from "node:fs/promises";
import path from "node:path";

export async function replaceFileAtomically(
  outputPath: string,
  writeTemporaryFile: (temporaryOutputPath: string) => Promise<void>,
): Promise<void> {
  const extension = path.extname(outputPath);
  const temporaryOutputPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath, extension)}.partial-${process.pid}-${Date.now()}${extension}`,
  );
  await writeTemporaryFile(temporaryOutputPath);
  await rename(temporaryOutputPath, outputPath);
}
