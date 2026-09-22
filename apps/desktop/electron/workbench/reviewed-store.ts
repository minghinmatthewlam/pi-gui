import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

interface ReviewedState {
  readonly version: 1;
  readonly marks: readonly string[];
}

/** Review acknowledgements only. Comparison data and Git content never enter this file. */
export class ReviewedStore {
  private readonly filePath: string;
  private loaded: Promise<Set<string>> | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, "reviewed-files.json");
  }

  async snapshot(): Promise<ReadonlySet<string>> {
    await this.pending;
    return new Set(await this.load());
  }

  async set(key: string, reviewed: boolean): Promise<void> {
    const write = this.pending.then(async () => {
      const previous = await this.load();
      if (previous.has(key) === reviewed) return;
      const next = new Set(previous);
      if (reviewed) next.add(key);
      else next.delete(key);
      const state: ReviewedState = { version: 1, marks: [...next].sort() };
      await writeFileAtomicQueued(
        this.filePath,
        `${JSON.stringify(state, null, 2)}\n`,
        decodeReviewedState,
      );
      this.loaded = Promise.resolve(next);
    });
    this.pending = write.catch(() => undefined);
    await write;
  }

  private load(): Promise<Set<string>> {
    this.loaded ??= readJsonWithBackup(this.filePath).then((result) => {
      if (result.corrupted && !result.recovered) {
        throw new Error("Reviewed-file metadata is invalid; the original file was retained.");
      }
      return new Set(result.value === undefined ? [] : decodeReviewedState(result.value).marks);
    });
    return this.loaded;
  }
}

function decodeReviewedState(value: unknown): ReviewedState {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "version" && key !== "marks") ||
    value.version !== 1 ||
    !Array.isArray(value.marks) ||
    value.marks.some((mark: unknown) => typeof mark !== "string" || !/^[a-f0-9]{64}$/.test(mark))
  ) {
    throw new Error("Reviewed-file metadata is invalid or unsupported; original data retained.");
  }
  const marks: string[] = [];
  for (const mark of value.marks) {
    if (typeof mark !== "string") throw new Error("Invalid reviewed-file mark.");
    marks.push(mark);
  }
  if (new Set(marks).size !== marks.length) throw new Error("Duplicate reviewed-file mark.");
  return { version: 1, marks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
