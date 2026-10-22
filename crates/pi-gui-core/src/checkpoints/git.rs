//! Runs `git` for turn captures with the same configuration and environment as the
//! TypeScript store: no fsmonitor, no untracked cache, no hooks, and none of the inherited
//! `GIT_*` routing variables (GIT_DIR, GIT_INDEX_FILE, ...) that would point it elsewhere.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The most output one command may produce, like `execFile`'s `maxBuffer`.
const MAX_OUTPUT: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct GitError(pub String);

/// Runs git in `cwd` and returns its stdout. The child is killed if the returned future is
/// dropped, which is how a capture's time limit or cancellation stops it.
pub async fn git<A: AsRef<OsStr>>(
    cwd: &Path,
    args: &[A],
    input: Option<&[u8]>,
    extra_env: &[(&str, &OsStr)],
) -> Result<Vec<u8>, GitError> {
    let hooks = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = tokio::process::Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
        ])
        .arg(format!("core.hooksPath={hooks}"))
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Keep normal global/system exclude configuration, but never inherited Git overrides.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in extra_env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: the core has no console, so git must not open one.
        command.creation_flags(0x0800_0000);
    }
    let describe = || {
        let args: Vec<String> = args
            .iter()
            .map(|arg| arg.as_ref().to_string_lossy().into_owned())
            .collect();
        format!("git {}", args.join(" "))
    };
    let mut child = command
        .spawn()
        .map_err(|error| GitError(format!("{}: {error}", describe())))?;
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let write = async {
        if let Some(mut stdin) = stdin.take() {
            if let Some(input) = input {
                // A command that exits without reading its input is reported by its status.
                let _ = stdin.write_all(input).await;
            }
            let _ = stdin.shutdown().await;
        }
    };
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let read_out = async {
        let read = (&mut stdout)
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut output)
            .await;
        if output.len() as u64 > MAX_OUTPUT {
            // Stop a child that would otherwise block on a full pipe.
            let _ = child.start_kill();
        }
        read
    };
    let read_err = stderr.read_to_end(&mut errors);
    let ((), read_out, _) = tokio::join!(write, read_out, read_err);
    read_out.map_err(|error| GitError(format!("{}: {error}", describe())))?;
    if output.len() as u64 > MAX_OUTPUT {
        let _ = child.wait().await;
        return Err(GitError(format!(
            "{}: stdout maxBuffer exceeded",
            describe()
        )));
    }
    let status = child
        .wait()
        .await
        .map_err(|error| GitError(format!("{}: {error}", describe())))?;
    if !status.success() {
        return Err(GitError(format!(
            "Command failed: {}\n{}",
            describe(),
            String::from_utf8_lossy(&errors)
        )));
    }
    Ok(output)
}

/// Text output without its one trailing line break.
pub fn strip_line(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text);
    text.to_owned()
}
