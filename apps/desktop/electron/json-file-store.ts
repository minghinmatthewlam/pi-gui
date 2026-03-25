import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class JsonFileStore<T> {
  private readonly rootDir: string;

  constructor(userDataDir: string, subdir: string) {
    this.rootDir = join(userDataDir, subdir);
  }

  async read(sessionKey: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.filePath(sessionKey), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async write(sessionKey: string, data: T): Promise<void> {
    const filePath = this.filePath(sessionKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}
