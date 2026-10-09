import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { writeFileAtomicQueued } from "./atomic-file-write";
import { isObject } from "../runtime/little-coder-discovery";

export interface RuntimeProfileBinding {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly profile: "little-coder";
  readonly version: "1.20.0";
  readonly piVersion: "0.83.0";
}

function decode(value: unknown): RuntimeProfileBinding[] {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.bindings)) {
    throw new Error("Invalid runtime profile bindings.");
  }
  const paths = new Set<string>();
  return value.bindings.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry.sessionFile !== "string" ||
      !isAbsolute(entry.sessionFile) ||
      typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 ||
      typeof entry.cwd !== "string" ||
      !isAbsolute(entry.cwd) ||
      entry.profile !== "little-coder" ||
      entry.version !== "1.20.0" ||
      entry.piVersion !== "0.83.0" ||
      paths.has(entry.sessionFile)
    ) {
      throw new Error("Unsupported or invalid saved runtime profile.");
    }
    paths.add(entry.sessionFile);
    return {
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      profile: entry.profile,
      version: entry.version,
      piVersion: entry.piVersion,
    };
  });
}

/** Runtime identity metadata only. Pi retains ownership of every transcript byte. */
export class RuntimeProfileStore {
  private static readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly filePath: string) {}

  private async read(): Promise<RuntimeProfileBinding[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return decode(value);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async require(sessionFile: string): Promise<RuntimeProfileBinding> {
    await RuntimeProfileStore.queues.get(this.filePath);
    const binding = (await this.read()).find((entry) => entry.sessionFile === sessionFile);
    if (!binding) throw new Error("Session has no verified Little Coder runtime binding.");
    return binding;
  }

  bind(binding: RuntimeProfileBinding): Promise<void> {
    decode({ version: 1, bindings: [binding] });
    const operation = (RuntimeProfileStore.queues.get(this.filePath) ?? Promise.resolve()).then(
      async () => {
        const entries = await this.read();
        const existing = entries.find((entry) => entry.sessionFile === binding.sessionFile);
        if (
          existing &&
          (existing.cwd !== binding.cwd ||
            existing.sessionId !== binding.sessionId ||
            existing.profile !== binding.profile ||
            existing.version !== binding.version ||
            existing.piVersion !== binding.piVersion)
        ) {
          throw new Error("Session runtime identity cannot be reassigned.");
        }
        if (existing) return;
        await writeFileAtomicQueued(
          this.filePath,
          JSON.stringify({ version: 1, bindings: [...entries, binding] }),
          decode,
        );
      },
    );
    RuntimeProfileStore.queues.set(
      this.filePath,
      operation.catch(() => {}),
    );
    return operation;
  }
}
