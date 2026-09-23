import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ReviewTarget } from "./contract";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40,64}$/;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error(`GitHub returned an invalid ${name}.`);
  return value;
}

export function relativeFile(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2048 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/[\0\r\n]/.test(value)
  );
}

export class ReviewRepository {
  constructor(
    readonly cwd: string,
    private readonly signal: AbortSignal,
  ) {}

  private async run(program: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
    this.signal.throwIfAborted();
    try {
      const { stdout } = await execute(program, args, {
        cwd: this.cwd,
        signal: this.signal,
        timeout: 20_000,
        maxBuffer,
        encoding: "utf8",
        // Reads must not take the index lock a concurrent git commit needs.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      return stdout;
    } catch (error) {
      this.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${program} could not read this PR: ${message.slice(0, 600)}`);
    }
  }

  async current(): Promise<ReviewTarget> {
    const checkout = await realpath(
      (await this.run("git", ["rev-parse", "--show-toplevel"])).trim(),
    );
    const raw: unknown = JSON.parse(
      await this.run("gh", [
        "pr",
        "view",
        "--json",
        "number,url,title,headRefName,headRefOid,baseRefOid",
      ]),
    );
    if (!raw || typeof raw !== "object") throw new Error("GitHub returned no PR metadata.");
    const info = raw as Record<string, unknown>;
    const url = new URL(text(info.url, "PR URL"));
    if (url.protocol !== "https:" || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname))
      throw new Error("GitHub returned an invalid PR URL.");
    const number = info.number;
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error("Invalid PR number.");
    const head = text(info.headRefOid, "head revision");
    const base = text(info.baseRefOid, "base revision");
    if (!SHA.test(head) || !SHA.test(base)) throw new Error("Invalid PR commit identity.");
    const localHead = (await this.run("git", ["rev-parse", "HEAD"])).trim();
    const mergeBase = (await this.run("git", ["merge-base", base, head])).trim();
    if (!SHA.test(mergeBase) || !SHA.test(localHead))
      throw new Error("Invalid local commit identity.");
    const files = (await this.run("git", ["diff", "--name-only", "-z", mergeBase, head, "--"]))
      .split("\0")
      .filter(Boolean);
    if (files.length > 200 || files.some((file) => !relativeFile(file)))
      throw new Error(
        "This example supports at most 200 changed files with ordinary relative paths.",
      );
    const dirty = Boolean(
      await this.run("git", ["status", "--porcelain", "--untracked-files=normal"]),
    );
    return {
      checkout,
      repository: `${url.host}/${url.pathname.split("/").slice(1, 3).join("/")}`,
      number: Number(number),
      url: url.href,
      title: text(info.title, "title"),
      branch: text(info.headRefName, "branch"),
      head,
      base,
      mergeBase,
      localHead,
      dirty,
      files,
    };
  }

  async read(target: ReviewTarget, kind: "diff" | "file", path: string): Promise<string> {
    if (!relativeFile(path)) throw new Error("Use a repository-relative file path.");
    if (kind === "diff") {
      if (!target.files.includes(path)) throw new Error("The file is not changed in this PR.");
      return this.run("git", [
        "--literal-pathspecs",
        "-C",
        target.checkout,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=5",
        target.mergeBase,
        target.head,
        "--",
        path,
      ]);
    }
    return this.run("git", ["-C", target.checkout, "show", `${target.head}:${path}`]);
  }
}
