import type { ComposerAttachment } from "../../contracts/desktop-state";
import { coreMethods } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

/**
 * Each thread's composer attachments, saved by the Rust core under `attachments/` in the
 * profile folder (`crates/pi-gui-core/src/persistence/attachments.rs`).
 */
export class AttachmentStore {
  constructor(private readonly core: RpcPeer) {}

  async read(sessionKey: string): Promise<ComposerAttachment[] | undefined> {
    const attachments = await this.core.request(coreMethods.attachmentsRead, { sessionKey });
    return attachments === null ? undefined : (attachments as ComposerAttachment[]);
  }

  async write(sessionKey: string, attachments: readonly ComposerAttachment[]): Promise<void> {
    await this.core.request(coreMethods.attachmentsWrite, { sessionKey, attachments });
  }

  async listKeys(): Promise<string[]> {
    return (await this.core.request(coreMethods.attachmentsListKeys)) as string[];
  }

  /** Refuses to delete saved attachments that do not read back cleanly. */
  async remove(sessionKey: string): Promise<void> {
    await this.core.request(coreMethods.attachmentsRemove, { sessionKey });
  }
}
