import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  PiSdkDriver,
  getAgentDir,
  type PiSdkDriverConfig,
  acquireLeaseFile,
  currentLeaseIdentity,
  defaultIsPidAlive,
  DEFAULT_LEASE_TTL_MS,
  refreshLeaseFile,
  releaseLeaseFile,
  sessionLeasePath,
} from "@pi-gui/pi-sdk-driver";
import {
  RuntimeProfileStore,
  type RuntimeProfileBinding,
} from "../persistence/runtime-profile-store";
import { discoverLittleCoder, isContained, isObject } from "./little-coder-discovery";
import { LittleCoderRpc } from "./little-coder-rpc";

export interface ExperimentalLittleCoderOptions {
  readonly enabled: true;
  readonly packageRoot: string;
  /** Child-only upstream configuration; never persisted as profile metadata. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface RuntimeProfileDiagnostic {
  readonly id: "standard-pi" | "little-coder";
  readonly available: boolean;
  readonly default: boolean;
  readonly interactivePlanning: boolean;
}

export interface RuntimeBootstrapSession {
  readonly binding: RuntimeProfileBinding;
  readonly pid: number | undefined;
  getCommands(): Promise<readonly string[]>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeBootstrapInput {
  readonly cwd: string;
  readonly sessionFile?: string;
}

/** Main-process composition seam. Experimental bootstrap is not a conversation driver. */
export class DesktopRuntimeProfiles {
  readonly standardDriver: PiSdkDriver;
  private readonly bindings: RuntimeProfileStore;
  private readonly agentDir: string;
  private readonly standardAgentDir: string;
  private readonly active = new Set<LittleCoderRpc>();
  private readonly opening = new Set<string>();
  private readonly identity = currentLeaseIdentity();
  private readonly leases = new Map<
    LittleCoderRpc,
    {
      readonly path: string;
      readonly timer: ReturnType<typeof setInterval>;
    }
  >();
  private disposed = false;

  constructor(
    private readonly userDataDir: string,
    driverOptions: PiSdkDriverConfig,
    private readonly littleCoder?: ExperimentalLittleCoderOptions,
  ) {
    this.standardDriver = new PiSdkDriver(driverOptions);
    this.standardAgentDir = resolve(driverOptions.agentDir ?? getAgentDir());
    this.agentDir = join(userDataDir, "little-coder", "agent");
    this.bindings = new RuntimeProfileStore(join(userDataDir, "runtime-profiles.json"));
  }

  async diagnostics(): Promise<readonly RuntimeProfileDiagnostic[]> {
    const standard = {
      id: "standard-pi",
      available: true,
      default: true,
      interactivePlanning: false,
    } as const;
    if (this.littleCoder?.enabled !== true) {
      return [
        standard,
        { id: "little-coder", available: false, default: false, interactivePlanning: false },
      ];
    }
    try {
      await discoverLittleCoder(this.littleCoder.packageRoot);
      return [
        standard,
        { id: "little-coder", available: true, default: false, interactivePlanning: false },
      ];
    } catch {
      return [
        standard,
        { id: "little-coder", available: false, default: false, interactivePlanning: false },
      ];
    }
  }

  async bootstrapLittleCoder(input: RuntimeBootstrapInput): Promise<RuntimeBootstrapSession> {
    if (this.littleCoder?.enabled !== true || this.disposed)
      throw new Error("Experimental Little Coder is disabled.");
    const installation = await discoverLittleCoder(this.littleCoder.packageRoot);
    const cwd = await realpath(input.cwd);
    await mkdir(this.userDataDir, { recursive: true });
    const userData = await realpath(this.userDataDir);
    const profileRoot = join(userData, "little-coder");
    await mkdir(profileRoot, { recursive: true });
    const canonicalProfileRoot = await realpath(profileRoot);
    if (!isContained(userData, canonicalProfileRoot))
      throw new Error("Little Coder profile directory escapes user data.");
    await mkdir(this.agentDir, { recursive: true });
    const agentDir = await realpath(this.agentDir);
    if (!isContained(userData, agentDir))
      throw new Error("Little Coder data directory escapes its profile.");
    let standardAgentDir = this.standardAgentDir;
    try {
      standardAgentDir = await realpath(standardAgentDir);
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
    }
    if (isContained(standardAgentDir, agentDir) || isContained(agentDir, standardAgentDir)) {
      throw new Error("Little Coder must not share Standard Pi's agent directory.");
    }
    const resumedFile = input.sessionFile ? await realpath(input.sessionFile) : undefined;
    let prior: RuntimeProfileBinding | undefined;
    let leasePath: string | undefined;
    if (resumedFile) {
      prior = await this.bindings.require(resumedFile);
      if (!isContained(agentDir, resumedFile))
        throw new Error("Session file escapes its runtime profile.");
      if (prior.cwd !== cwd)
        throw new Error("Cannot resume a runtime session in another workspace.");
      await verifyHeader(resumedFile, prior.sessionId, cwd);
      if (this.opening.has(resumedFile)) throw new Error("Runtime session is already open.");
      this.opening.add(resumedFile);
      try {
        leasePath = await this.claimLease(resumedFile);
      } catch (error) {
        this.opening.delete(resumedFile);
        throw error;
      }
    }
    const rpc = new LittleCoderRpc({
      launcher: installation.launcher,
      cwd,
      agentDir,
      sessionFile: resumedFile,
      environment: this.littleCoder.environment,
    });
    this.active.add(rpc);
    if (leasePath) this.watchLease(rpc, leasePath);
    let boundFile: string | undefined;
    try {
      const value = await rpc.command("get_state");
      if (
        !isObject(value) ||
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0 ||
        typeof value.sessionFile !== "string" ||
        !isAbsolute(value.sessionFile) ||
        !value.sessionFile.endsWith(".jsonl")
      ) {
        throw new Error("Little Coder did not provide a persistent session identity.");
      }
      // New Pi sessions may not have persisted their JSONL yet. Canonicalize the parent
      // without creating or writing the transcript ourselves.
      let sessionFile: string;
      try {
        sessionFile = await realpath(value.sessionFile);
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
        sessionFile = join(await realpath(dirname(value.sessionFile)), basename(value.sessionFile));
      }
      if (!isContained(agentDir, sessionFile))
        throw new Error("Session file escapes its runtime profile.");
      if (prior && (prior.sessionId !== value.sessionId || prior.sessionFile !== sessionFile)) {
        throw new Error("Little Coder resumed a different session.");
      }
      if (!prior && this.opening.has(sessionFile))
        throw new Error("Runtime session is already open.");
      if (!prior) {
        this.opening.add(sessionFile);
        boundFile = sessionFile;
        leasePath = await this.claimLease(sessionFile);
        this.watchLease(rpc, leasePath);
      }
      if (this.disposed) throw new Error("Runtime profile host closed during startup.");
      const binding: RuntimeProfileBinding = {
        profile: "little-coder",
        version: installation.version,
        piVersion: installation.piVersion,
        cwd,
        sessionFile,
        sessionId: value.sessionId,
      };
      await this.bindings.bind(binding);
      if (this.disposed) throw new Error("Runtime profile host closed during startup.");
      this.opening.add(sessionFile);
      boundFile = sessionFile;
      return {
        binding,
        pid: rpc.pid,
        getCommands: async () => {
          const result = await rpc.command("get_commands");
          if (!isObject(result) || !Array.isArray(result.commands))
            throw new Error("Invalid runtime commands.");
          return result.commands.map((command: unknown) => {
            if (!isObject(command) || typeof command.name !== "string")
              throw new Error("Invalid runtime command.");
            return command.name;
          });
        },
        cancel: async () => {
          await rpc.command("abort");
        },
        close: async () => {
          await this.closeRpc(rpc);
          this.opening.delete(sessionFile);
        },
      };
    } catch (error) {
      await this.closeRpc(rpc);
      if (resumedFile) this.opening.delete(resumedFile);
      if (boundFile) this.opening.delete(boundFile);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.active].map((rpc) => this.closeRpc(rpc)));
    this.active.clear();
    this.opening.clear();
  }

  private async claimLease(sessionFile: string): Promise<string> {
    const path = sessionLeasePath(sessionFile);
    const result = await acquireLeaseFile(path, {
      self: this.identity,
      now: Date.now(),
      ttlMs: DEFAULT_LEASE_TTL_MS,
      isPidAlive: defaultIsPidAlive,
    });
    if (result.status !== "acquired") throw new Error("Runtime session is leased by another host.");
    return path;
  }

  private watchLease(rpc: LittleCoderRpc, path: string): void {
    const timer = setInterval(() => {
      refreshLeaseFile(path, this.identity, Date.now())
        .then((result) => {
          if (result === "lost") return rpc.close();
        })
        .catch(() => rpc.close().catch(() => {}));
    }, 60_000);
    timer.unref();
    this.leases.set(rpc, { path, timer });
  }

  private async closeRpc(rpc: LittleCoderRpc): Promise<void> {
    await rpc.close();
    this.active.delete(rpc);
    const lease = this.leases.get(rpc);
    if (lease) {
      clearInterval(lease.timer);
      this.leases.delete(rpc);
      await releaseLeaseFile(lease.path, this.identity);
    }
  }
}

async function verifyHeader(path: string, sessionId: string, cwd: string): Promise<void> {
  const file = await open(path, "r");
  let header: unknown;
  try {
    const bytes = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) throw new Error("Session header is missing or too large.");
    header = JSON.parse(text.slice(0, newline));
  } finally {
    await file.close();
  }
  if (
    !isObject(header) ||
    header.type !== "session" ||
    header.version !== 3 ||
    header.id !== sessionId ||
    typeof header.cwd !== "string" ||
    (await realpath(header.cwd)) !== cwd
  ) {
    throw new Error("Session header does not match its runtime binding.");
  }
}
