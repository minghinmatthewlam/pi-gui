export const TERMINAL_REPLAY_BUFFER_LENGTH = 1_000_000;

export interface TerminalReplayUpdate {
  readonly replay: string;
  readonly truncated: boolean;
}

export function appendTerminalReplay(
  replay: string,
  data: string,
  alreadyTruncated = false,
): TerminalReplayUpdate {
  const nextReplay = replay + data;
  if (nextReplay.length <= TERMINAL_REPLAY_BUFFER_LENGTH) {
    return { replay: nextReplay, truncated: alreadyTruncated };
  }

  return {
    replay: nextReplay.slice(-TERMINAL_REPLAY_BUFFER_LENGTH),
    truncated: true,
  };
}
