/**
 * Environment for app-owned Git reads and writes. Inherited `GIT_*` overrides such as
 * GIT_DIR, GIT_INDEX_FILE and GIT_WORK_TREE would redirect a command away from the
 * checkout or store it was pointed at, so none of them reach the child process.
 */
export function isolatedGitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extra };
}
