import { coreMethods } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

/** Review acknowledgements only. Comparison data and Git content never enter this store. */
export interface ReviewedMarks {
  snapshot(): Promise<ReadonlySet<string>>;
  set(key: string, reviewed: boolean): Promise<void>;
}

/**
 * Review marks saved by the Rust core in `reviewed-files.json`
 * (`crates/pi-gui-core/src/persistence/reviewed.rs`). Marks are kept oldest first; beyond
 * the limit the oldest acknowledgements are forgotten.
 */
export class ReviewedStore implements ReviewedMarks {
  constructor(private readonly core: RpcPeer) {}

  async snapshot(): Promise<ReadonlySet<string>> {
    return new Set((await this.core.request(coreMethods.reviewedSnapshot)) as string[]);
  }

  async set(key: string, reviewed: boolean): Promise<void> {
    await this.core.request(coreMethods.reviewedSet, { key, reviewed });
  }
}
