import type { SessionRef } from "@pi-gui/session-driver";
import type { SaveTaskWorkbenchTemplateInput } from "../../contracts/workbench";
import type { DesktopAppStore } from "../application/app-store";
import { SerializedActionQueue } from "../windows/action-queue";

export type WorkbenchOwner = Pick<
  DesktopAppStore,
  "getTaskWorkbenchTemplate" | "saveTaskWorkbenchTemplate"
>;

/** Main owns the saved template; callers retain independent live window state. */
export class WorkbenchRequests {
  private readonly renderers = new WeakMap<object, { sequence: number }>();
  private readonly queue = new SerializedActionQueue();

  constructor(private readonly owner: WorkbenchOwner) {}

  resetRenderer(sender: object): void {
    this.renderers.delete(sender);
  }

  /** Inputs are decoded at the IPC boundary (expectSessionTarget / expectSaveTaskWorkbenchTemplateInput). */
  get(target: SessionRef) {
    return this.queue.run(() => this.owner.getTaskWorkbenchTemplate(target));
  }

  save(sender: object, input: SaveTaskWorkbenchTemplateInput): Promise<void> {
    const renderer = this.renderers.get(sender) ?? { sequence: 0 };
    if (input.sequence <= renderer.sequence) return Promise.resolve();
    renderer.sequence = input.sequence;
    this.renderers.set(sender, renderer);
    return this.queue.run(async () => {
      // A renderer reload invalidates requests that have not started writing yet.
      if (this.renderers.get(sender) !== renderer) return;
      await this.owner.saveTaskWorkbenchTemplate(input.target, input.template);
    });
  }
}
