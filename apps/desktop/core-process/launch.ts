/**
 * Starts the Rust `pi-gui-core` process and connects to it over its stdin and stdout. Unlike
 * the pi host, nothing but the core's own code runs in it, so stdout is safe to use as the
 * pipe; its diagnostics go to stderr.
 */
import { spawn } from "node:child_process";
import { RpcPeer } from "../rpc/rpc-peer";
import { coreMethods, type CoreInitializeParams } from "./protocol";

export interface CoreProcess {
  readonly peer: RpcPeer;
  readonly pid: number | undefined;
  /** Asks the core to finish its current call and exit; kills it after the timeout. */
  stop(timeoutMs: number): Promise<void>;
}

export interface StartCoreOptions {
  readonly binaryPath: string;
  readonly initialize: CoreInitializeParams;
  /** Called when the core exits without being asked to. */
  readonly onUnexpectedExit: (detail: string) => void;
}

export async function startCore(options: StartCoreOptions): Promise<CoreProcess> {
  const child = spawn(options.binaryPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const peer = new RpcPeer({
    transport: {
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
      close: () => {
        child.stdin.end();
      },
    },
    onDiagnostic: (message) => console.error(`[pi-gui-core] ${message}`),
    label: "pi-gui core",
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => peer.receiveChunk(chunk));
  // A write after the core exits reports EPIPE here; the exit handler below reports why.
  child.stdin.on("error", () => undefined);

  let stopping = false;
  // Until it has started, a failure is a startup error for the caller, not a crash.
  let started = false;
  const exited = new Promise<void>((resolve) => {
    const finish = (detail: string) => {
      peer.close(detail);
      if (started && !stopping) options.onUnexpectedExit(detail);
      resolve();
    };
    // `close` waits for stdout to drain, so replies the core already sent are still read.
    child.once("close", (code, signal) =>
      finish(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`),
    );
    child.once("error", (error) => finish(error.message));
  });

  try {
    await peer.request(coreMethods.initialize, options.initialize);
  } catch (error) {
    stopping = true;
    child.kill();
    await exited;
    throw new Error(
      `pi-gui could not start its core process at ${options.binaryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  started = true;

  return {
    peer,
    pid: child.pid,
    async stop(timeoutMs) {
      if (stopping) return exited;
      stopping = true;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      try {
        await Promise.race([peer.request(coreMethods.shutdown).catch(() => undefined), exited]);
        peer.close("app is quitting");
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
