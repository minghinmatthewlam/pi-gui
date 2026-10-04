/**
 * Starts the pi host process and connects the message pipe to it.
 *
 * The pipe is a local socket (a Unix socket in a private folder, or a Windows named pipe)
 * rather than the host's stdout, so output from tools and extensions that inherit stdout can
 * never corrupt it. The host proves it is the process we started by sending a one-time token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PI_HOST_SOCKET_ENV, PI_HOST_TOKEN_ENV } from "./host-env";
import { hostMethods, type PiHostInitializeParams } from "./protocol";
import { RpcPeer } from "../rpc/rpc-peer";

export interface PiHostProcess {
  readonly peer: RpcPeer;
  readonly pid: number | undefined;
  /** Waits for the host to connect, then sends its startup settings. */
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

const CONNECT_TIMEOUT_MS = 30_000;

export async function startPiHost(options: StartPiHostOptions): Promise<PiHostProcess> {
  const token = randomBytes(32).toString("hex");
  const { address, cleanup } = await socketAddress();
  let connection: Socket | undefined;
  const peer = new RpcPeer({
    transport: {
      send: (line) => {
        connection?.write(`${line}\n`);
      },
      close: () => {
        connection?.end();
      },
    },
    onDiagnostic: (message) => console.error(`[pi-host] ${message}`),
  });
  const server = createServer();
  const connected = acceptHost(server, token, peer).then((socket) => {
    connection = socket;
    server.close();
    cleanup().catch(() => undefined);
  });
  let child: ChildProcess;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => resolve());
    });
    child = spawn(options.execPath, [options.scriptPath], {
      env: { ...options.env, [PI_HOST_SOCKET_ENV]: address, [PI_HOST_TOKEN_ENV]: token },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  } catch (error) {
    server.close();
    await cleanup();
    throw error;
  }
  let stopping = false;
  const exited = new Promise<void>((resolve) => {
    const finish = (detail: string) => {
      peer.close(detail);
      server.close();
      cleanup().catch(() => undefined);
      if (!stopping) options.onUnexpectedExit(detail);
      resolve();
    };
    child.once("exit", (code, signal) =>
      finish(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`),
    );
    child.once("error", (error) => finish(error.message));
  });

  return {
    peer,
    pid: child.pid,
    async initialize(params) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connected,
          exited.then(() => Promise.reject(new Error("pi host exited before it connected"))),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("pi host did not connect in time")),
              CONNECT_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await peer.request(hostMethods.initialize, params);
    },
    async stop(timeoutMs) {
      if (stopping) return exited;
      stopping = true;
      // A host that never connected cannot hear the shutdown request.
      if (!connection) child.kill();
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

/** Accepts the first connection that presents the token; drops any other. */
function acceptHost(server: Server, token: string, peer: RpcPeer): Promise<Socket> {
  return new Promise((resolve) => {
    let accepted = false;
    server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      if (accepted) {
        socket.destroy();
        return;
      }
      socket.setEncoding("utf8");
      let greeting = "";
      const onGreeting = (chunk: string) => {
        greeting += chunk;
        const newline = greeting.indexOf("\n");
        if (newline < 0) {
          if (greeting.length > token.length + 2) socket.destroy();
          return;
        }
        socket.off("data", onGreeting);
        if (accepted || greeting.slice(0, newline) !== token) {
          socket.destroy();
          return;
        }
        accepted = true;
        socket.on("data", (data: string) => peer.receiveChunk(data));
        socket.on("close", () => peer.close("pi host closed the pipe"));
        const rest = greeting.slice(newline + 1);
        if (rest) peer.receiveChunk(rest);
        resolve(socket);
      };
      socket.on("data", onGreeting);
    });
  });
}

async function socketAddress(): Promise<{ address: string; cleanup: () => Promise<void> }> {
  const id = randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return { address: `\\\\.\\pipe\\pi-gui-host-${id}`, cleanup: async () => undefined };
  }
  // A private folder: only this user can reach the socket inside it.
  const directory = await mkdtemp(path.join(tmpdir(), "pi-gui-"));
  let removed = false;
  return {
    address: path.join(directory, "host.sock"),
    cleanup: async () => {
      if (removed) return;
      removed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
