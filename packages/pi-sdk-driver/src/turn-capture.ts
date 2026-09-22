import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
  TurnCaptureBoundary,
  TurnCaptureClosing,
  TurnCaptureObserver,
  TurnCaptureOpening,
  WorkspaceRef,
} from "@pi-gui/session-driver";

interface CaptureOptions {
  readonly workspace: WorkspaceRef;
  readonly observer: TurnCaptureObserver;
  readonly timeoutMs: number | undefined;
  readonly getRunId: (sessionId: string) => string;
  readonly isCancelled: (sessionId: string) => boolean;
  readonly isInterrupted: (sessionId: string) => boolean;
}

interface ActiveCapture {
  readonly runId: string;
  readonly opening: TurnCaptureOpening;
  hasAssistantWork: boolean;
  outcome: TurnCaptureClosing["outcome"];
  captureError: string | undefined;
}

/** Capture tool activity through supported, awaited Pi extension hooks. */
export function createTurnCaptureExtension(options: CaptureOptions): ExtensionFactory {
  return (pi) => {
    // The factory is invoked again on reload, even when the Pi session ID is unchanged.
    const runtimeGeneration = randomUUID();
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
        ? Math.min(options.timeoutMs!, 30_000)
        : 2_000;
    let active: ActiveCapture | undefined;

    const open = (ctx: ExtensionContext, runId: string): ActiveCapture => ({
      runId,
      opening: {
        checkpointId: randomUUID(),
        beforeEntryId: ctx.sessionManager.getLeafId(),
        startedAt: new Date().toISOString(),
      },
      hasAssistantWork: false,
      outcome: "completed",
      captureError: undefined,
    });

    const close = (
      ctx: ExtensionContext,
      current: ActiveCapture,
      reason: TurnCaptureClosing["reason"],
    ): TurnCaptureClosing => {
      const branch = ctx.sessionManager.getBranch();
      const beforeIndex =
        current.opening.beforeEntryId === null
          ? -1
          : branch.findIndex((entry) => entry.id === current.opening.beforeEntryId);
      const branchChanged = current.opening.beforeEntryId !== null && beforeIndex < 0;
      const entries = branchChanged ? [] : branch.slice(beforeIndex + 1);
      const userEntryIds = entries
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id);
      const assistantEntryIds = entries
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
        .map((entry) => entry.id);
      const captureError =
        current.captureError ??
        (branchChanged
          ? "Transcript branch changed before the capture finished."
          : current.hasAssistantWork && assistantEntryIds.length === 0
            ? "Assistant transcript anchors are unavailable."
            : undefined);
      return {
        ...current.opening,
        userEntryIds,
        assistantEntryIds,
        lastEntryId: ctx.sessionManager.getLeafId(),
        outcome:
          reason === "runtime-replaced" || options.isInterrupted(ctx.sessionManager.getSessionId())
            ? "interrupted"
            : options.isCancelled(ctx.sessionManager.getSessionId())
              ? "stopped"
              : current.outcome,
        reason,
        ...(captureError ? { captureError } : {}),
      };
    };

    const capture = async (
      ctx: ExtensionContext,
      current: ActiveCapture,
      change: Pick<TurnCaptureBoundary, "opening" | "closing">,
      interruptible: boolean,
    ): Promise<string | undefined> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeAbort: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          const stop = (message: string) => {
            controller.abort();
            reject(new Error(message));
          };
          timer = setTimeout(() => stop("Checkpoint capture timed out."), timeoutMs);
          const signal = interruptible ? ctx.signal : undefined;
          if (signal?.aborted) stop("Checkpoint capture was interrupted.");
          else if (signal) {
            const abort = () => stop("Checkpoint capture was interrupted.");
            signal.addEventListener("abort", abort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", abort);
          }
        });
        const boundary: TurnCaptureBoundary = {
          sessionRef: {
            workspaceId: options.workspace.workspaceId,
            sessionId: ctx.sessionManager.getSessionId(),
          },
          workspace: { ...options.workspace, path: ctx.cwd },
          runtimeGeneration,
          runId: current.runId,
          timestamp: new Date().toISOString(),
          ...change,
        };
        await Promise.race([
          Promise.resolve().then(() => options.observer(boundary, controller.signal)),
          deadline,
        ]);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        if (timer) clearTimeout(timer);
        removeAbort?.();
      }
    };

    pi.on("agent_start", async (_event, ctx) => {
      if (active) return; // Retry and before-settle continuation retain the original baseline.
      const next = open(ctx, options.getRunId(ctx.sessionManager.getSessionId()));
      active = next;
      next.captureError = await capture(ctx, next, { opening: next.opening }, true);
    });
    pi.on("message_start", async (event, ctx) => {
      if (event.message.role !== "user" || !active?.hasAssistantWork) return;
      const previous = active;
      const next = open(ctx, previous.runId);
      active = next;
      next.captureError = await capture(
        ctx,
        next,
        {
          closing: close(ctx, previous, "next-input"),
          opening: next.opening,
        },
        true,
      );
    });
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant" || !active) return;
      active.hasAssistantWork = true;
      active.outcome =
        event.message.stopReason === "aborted"
          ? "stopped"
          : event.message.stopReason === "error"
            ? "failed"
            : "completed";
    });
    pi.on("turn_end", (event) => {
      if (!active) return;
      active.outcome =
        event.outcome === "aborted"
          ? "stopped"
          : event.outcome === "error"
            ? "failed"
            : "completed";
    });
    pi.on("agent_settled", async (_event, ctx) => {
      const current = active;
      active = undefined; // A prompt from another settled hook belongs to a fresh activity.
      if (current) await capture(ctx, current, { closing: close(ctx, current, "settled") }, false);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const current = active;
      active = undefined;
      if (current)
        await capture(ctx, current, { closing: close(ctx, current, "runtime-replaced") }, false);
    });
  };
}
