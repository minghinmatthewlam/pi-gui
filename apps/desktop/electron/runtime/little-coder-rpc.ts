import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { isObject } from "./little-coder-discovery";

const MAX_BYTES = 1_048_576;
const MAX_PENDING = 32;

interface PendingCommand {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RpcLaunch {
  readonly launcher: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionFile?: string;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

/** A bounded transport, not an AgentSessionRuntime impersonation or transcript owner. */
export class LittleCoderRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private readonly exited: Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: RpcLaunch) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Invalid RPC timeout.");
    }
    this.child = spawn(
      process.execPath,
      [
        options.launcher,
        "--no-update-check",
        "--mode",
        "rpc",
        ...(options.sessionFile ? ["--session", options.sessionFile] : []),
      ],
      {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          ...options.environment,
          ELECTRON_RUN_AS_NODE: "1",
          PI_CODING_AGENT_DIR: options.agentDir,
          LITTLE_CODER_PLAN_MODE: "0",
          LITTLE_CODER_SUBAGENT: "0",
        },
        stdio: "pipe",
      },
    );
    // Drain stderr without retaining potentially credential-bearing runtime output.
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdin.on("error", () => this.fail(new Error("Little Coder RPC input failed.")));
    this.child.on("error", () => this.fail(new Error("Little Coder process failed to start.")));
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.on("exit", () => this.fail(new Error("Little Coder RPC process exited.")));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  command(command: "get_state" | "get_commands" | "abort"): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error("RPC command limit reached."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Little Coder RPC command timed out."));
      }, this.timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      this.send({ id, type: command });
    });
  }

  private send(value: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) {
        this.fail(new Error("Little Coder RPC line exceeds its limit."));
        return;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value) || typeof value.type !== "string")
          throw new Error("Invalid RPC envelope.");
        this.message(value);
      } catch {
        this.fail(new Error("Invalid Little Coder RPC output."));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_BYTES) {
      this.fail(new Error("Little Coder RPC buffer exceeds its limit."));
    }
  }

  private message(message: Record<string, unknown>): void {
    if (message.type === "response") {
      if (typeof message.id !== "string" || typeof message.success !== "boolean") {
        throw new Error("Invalid RPC response.");
      }
      const pending = this.pending.get(message.id);
      if (!pending || message.command !== pending.command)
        throw new Error("Uncorrelated RPC response.");
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.success) pending.resolve(message.data);
      else pending.reject(new Error("Little Coder rejected the RPC command."));
      return;
    }
    if (message.type === "extension_ui_request") {
      if (typeof message.id !== "string" || typeof message.method !== "string") {
        throw new Error("Invalid RPC UI request.");
      }
      // WP-002 has no interactive UI bridge. Deny/cancel every dialog, never auto-approve.
      if (["confirm", "select", "input", "editor"].includes(message.method)) {
        this.send({ type: "extension_ui_response", id: message.id, cancelled: true });
      } else if (
        !["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(
          message.method,
        )
      ) {
        throw new Error("Unsupported RPC UI method.");
      }
      return;
    }
    if (message.type === "extension_error") throw new Error("Little Coder extension failed.");
    // This bootstrap-only transport never submits prompts or claims mapped agent events.
    throw new Error("Unexpected RPC event during runtime bootstrap.");
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.failure ??= new Error("Little Coder RPC connection closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.closing = this.stopTree();
    return this.closing;
  }

  private async stopTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) {
      await this.exited;
      return;
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) =>
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (error) => {
          if (error && this.child.exitCode === null) reject(error);
          else resolve();
        }),
      );
      await this.exited;
      return;
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!isObject(error) || error.code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    // Descendants may keep inherited pipes open after the launcher exits.
    await Promise.all([
      this.exited,
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          try {
            kill("SIGKILL");
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 250),
      ),
    ]);
  }
}
