import type { DesktopAppStore } from "../application/app-store";
import { SerializedActionQueue } from "../windows/action-queue";
import { expectSaveTaskWorkbenchTemplateInput, expectSessionTarget } from "./request-validation";

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

  get(rawTarget: unknown) {
    const target = expectSessionTarget(rawTarget);
    return this.queue.run(() => this.owner.getTaskWorkbenchTemplate(target));
  }

  save(sender: object, rawInput: unknown): Promise<void> {
    const input = expectSaveTaskWorkbenchTemplateInput(rawInput);
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
