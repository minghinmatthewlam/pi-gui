import { join } from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

interface ReviewedState {
  readonly version: 1;
  readonly marks: readonly string[];
}

/** Enough for one maximal review list (2,000 files) plus recent history. */
const DEFAULT_MAX_MARKS = 5_000;

/**
 * Review acknowledgements only. Comparison data and Git content never enter this file.
 * Marks are kept oldest first; beyond the cap the oldest acknowledgements are forgotten.
 */
export class ReviewedStore {
  private readonly filePath: string;
  private readonly maxMarks: number;
  private loaded: Promise<Set<string>> | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, options: { readonly maxMarks?: number } = {}) {
    this.filePath = join(userDataDir, "reviewed-files.json");
    this.maxMarks = options.maxMarks ?? DEFAULT_MAX_MARKS;
    if (!Number.isSafeInteger(this.maxMarks) || this.maxMarks < 1)
      throw new Error("The reviewed-mark limit must be a positive safe integer.");
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
      for (const mark of next) {
        if (next.size <= this.maxMarks) break;
        next.delete(mark);
      }
      const state: ReviewedState = { version: 1, marks: [...next] };
      await writeFileAtomicQueued(this.filePath, `${JSON.stringify(state)}\n`, decodeReviewedState);
      this.loaded = Promise.resolve(next);
    });
    this.pending = write.catch(() => undefined);
    await write;
  }

  private load(): Promise<Set<string>> {
    this.loaded ??= readJsonWithBackup(this.filePath)
      .then((result) => {
        if (result.corrupted && !result.recovered) {
          throw new Error("Reviewed-file metadata is invalid; the original file was retained.");
        }
        return new Set(result.value === undefined ? [] : decodeReviewedState(result.value).marks);
      })
      .catch((error: unknown) => {
        // A transient read failure must not disable marks until restart.
        this.loaded = undefined;
        throw error;
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
