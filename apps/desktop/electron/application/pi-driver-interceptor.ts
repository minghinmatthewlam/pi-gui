import { PI_DRIVER_METHODS, type PiDriverMethod, type PiDriverPort } from "../../pi-host/protocol";

/** One call the app made to pi while a test held that method. */
export interface InterceptedPiDriverCall {
  readonly id: string;
  readonly method: PiDriverMethod;
  readonly args: readonly unknown[];
  readonly outcome: "pending" | "completed" | "failed";
}

/**
 * Test mode only. Holds the app's calls to chosen pi methods until the test answers them, so a
 * spec can keep a run open, fail a send or watch what reaches pi without a provider. The calls
 * stay on the app's side of the pi host pipe; pi itself never sees them.
 */
export class PiDriverInterceptor {
  private readonly originals = new Map<PiDriverMethod, unknown>();
  private readonly calls: InterceptedPiDriverCall[] = [];
  private readonly settle = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private nextId = 1;

  constructor(private readonly driver: PiDriverPort) {}

  intercept(method: PiDriverMethod): void {
    if (!PI_DRIVER_METHODS.includes(method)) throw new Error(`Unknown pi method: ${method}`);
    if (this.originals.has(method)) return;
    const methods = this.driver as unknown as Record<PiDriverMethod, unknown>;
    this.originals.set(method, methods[method]);
    methods[method] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = `${method}-${this.nextId++}`;
        this.calls.push({ id, method, args, outcome: "pending" });
        this.settle.set(id, { resolve, reject });
      });
  }

  /** Puts the method back; calls already held stay held until answered. */
  restore(method: PiDriverMethod): void {
    if (!this.originals.has(method)) return;
    (this.driver as unknown as Record<PiDriverMethod, unknown>)[method] =
      this.originals.get(method);
    this.originals.delete(method);
  }

  list(method?: PiDriverMethod): readonly InterceptedPiDriverCall[] {
    return this.calls.filter((call) => method === undefined || call.method === method);
  }

  complete(id: string, result?: unknown): void {
    this.answer(id, "completed").resolve(result);
  }

  fail(id: string, message: string): void {
    this.answer(id, "failed").reject(new Error(message));
  }

  private answer(id: string, outcome: "completed" | "failed") {
    const settle = this.settle.get(id);
    const index = this.calls.findIndex((call) => call.id === id);
    if (!settle || index === -1) throw new Error(`No held pi call ${id}`);
    this.settle.delete(id);
    this.calls[index] = { ...this.calls[index]!, outcome };
    return settle;
  }
}
