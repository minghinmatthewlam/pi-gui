/**
 * Compatibility boundary for Pi 0.85.1 session persistence.
 *
 * Pi defers its first session-file write. The desktop needs an early write after
 * metadata changes, but Pi does not currently expose that operation publicly.
 * Keep the private shape and its `flushed` bookkeeping isolated here so an
 * upstream API change has one explicit failure point.
 */
interface PersistablePiSessionManager {
  _rewriteFile?: () => void;
  flushed?: boolean;
}

export function forcePersistPiSession(sessionManager: object): void {
  const compatibleManager = sessionManager as PersistablePiSessionManager;
  const rewriteFile = compatibleManager._rewriteFile;
  if (!rewriteFile) {
    return;
  }

  rewriteFile.call(sessionManager);
  // Pi 0.85.1 switches from create to append after its first write. Keep that
  // private state aligned when pi-gui forces the write early.
  compatibleManager.flushed = true;
}
