/**
 * Starts the pi host process and connects the message pipe to it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { hostMethods, type PiHostInitializeParams } from "./protocol";
import { RpcPeer } from "./rpc-peer";

export interface PiHostProcess {
  readonly peer: RpcPeer;
  readonly pid: number | undefined;
  /** Sends the host its startup settings; driver calls work once this resolves. */
  initialize(params: PiHostInitializeParams): Promise<void>;
  /** Lets the host dispose extension views, then ends it. */
  stop(timeoutMs: number): Promise<void>;
}

export interface StartPiHostOptions {
  /** The Node executable. Under Electron this is Electron itself in Node mode. */
  readonly execPath: string;
  readonly scriptPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Called when the host exits without being asked to. */
  readonly onUnexpectedExit: (detail: string) => void;
}

export function startPiHost(options: StartPiHostOptions): PiHostProcess {
  const child: ChildProcess = spawn(options.execPath, [options.scriptPath], {
    env: options.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  let stopping = false;
  const peer = new RpcPeer({
    transport: {
      send: (line) => {
        child.stdin?.write(`${line}\n`);
      },
      close: () => {
        child.stdin?.end();
      },
    },
    onDiagnostic: (message) => console.error(`[pi-host] ${message}`),
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => peer.receiveChunk(chunk));
  child.stdin?.on("error", () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      peer.close(detail);
      if (!stopping) options.onUnexpectedExit(detail);
      resolve();
    });
    child.once("error", (error) => {
      peer.close(error.message);
      if (!stopping) options.onUnexpectedExit(error.message);
      resolve();
    });
  });

  return {
    peer,
    pid: child.pid,
    async initialize(params) {
      await peer.request(hostMethods.initialize, params);
    },
    async stop(timeoutMs) {
      if (stopping) return exited;
      stopping = true;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      try {
        await Promise.race([peer.request(hostMethods.shutdown).catch(() => undefined), exited]);
        peer.close("app is quitting");
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
