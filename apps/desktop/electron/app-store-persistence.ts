import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ComposerImageAttachment, TranscriptMessage } from "../src/desktop-state";

export interface PersistedUiState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly composerDraftsBySession?: Record<string, string>;
  readonly composerAttachmentsBySession?: Record<string, readonly ComposerImageAttachment[]>;
  readonly transcripts?: Record<string, readonly TranscriptMessage[]>;
}

export async function readPersistedUiState(uiStateFilePath: string): Promise<PersistedUiState> {
  try {
    const raw = await readFile(uiStateFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedUiState;
    return {
      selectedWorkspaceId: parsed.selectedWorkspaceId,
      selectedSessionId: parsed.selectedSessionId,
      composerDraft: parsed.composerDraft ?? "",
      composerDraftsBySession: parsed.composerDraftsBySession,
      composerAttachmentsBySession: parsed.composerAttachmentsBySession,
      transcripts: parsed.transcripts,
    };
  } catch {
    return {};
  }
}

export async function writePersistedUiState(
  uiStateFilePath: string,
  payload: PersistedUiState,
): Promise<void> {
  await mkdir(dirname(uiStateFilePath), { recursive: true });
  await writeFile(uiStateFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
