//! pi-gui's Git work: app worktrees, review comparisons and staging, and the file list,
//! file contents and diffs the workbench shows. Every command shells out to `git` with the
//! same arguments, environment and output limits the TypeScript code used, and runs without
//! blocking other calls.

pub mod review;
pub mod workspace_files;
pub mod worktrees;

use crate::error::CoreError;
use serde_json::{Map, Value};
use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Node's default `maxBuffer` for `execFile`.
pub const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

/// Tests point this at a stand-in to see the exact arguments the core passes.
const GIT_PROGRAM_OVERRIDE: &str = "PI_GUI_CORE_GIT_PROGRAM";

pub struct GitCommand<'a> {
    args: Vec<&'a OsStr>,
    cwd: Option<&'a Path>,
    isolated: bool,
    max_buffer: usize,
    timeout: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    /// Ended by a signal, including the kill after a timeout or a full output buffer.
    Killed,
}

pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Exit,
    /// Output passed `max_buffer` and was cut there; the command was stopped.
    pub truncated: bool,
    pub timed_out: bool,
    /// For error messages: `git` and its arguments, as Node prints them.
    command_line: String,
}

impl<'a> GitCommand<'a> {
    pub fn new<S: AsRef<OsStr> + ?Sized + 'a>(args: impl IntoIterator<Item = &'a S>) -> Self {
        Self {
            args: args.into_iter().map(AsRef::as_ref).collect(),
            cwd: None,
            isolated: false,
            max_buffer: DEFAULT_MAX_BUFFER,
            timeout: None,
        }
    }

    pub fn cwd(mut self, cwd: &'a Path) -> Self {
        self.cwd = Some(cwd);
        self
    }

    /// `isolatedGitEnvironment()`: inherited `GIT_*` overrides such as GIT_DIR, GIT_INDEX_FILE
    /// and GIT_WORK_TREE would redirect a command away from the checkout it was pointed at,
    /// so none reach Git, and reads never take the index lock the user's own commands need.
    pub fn isolated(mut self) -> Self {
        self.isolated = true;
        self
    }

    pub fn max_buffer(mut self, bytes: usize) -> Self {
        self.max_buffer = bytes;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Runs Git to the end. Fails only when it cannot start, like `execFile`'s spawn error.
    pub async fn output(self) -> Result<GitOutput, CoreError> {
        let program = std::env::var_os(GIT_PROGRAM_OVERRIDE).unwrap_or_else(|| "git".into());
        let mut command = tokio::process::Command::new(&program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = self.cwd {
            command.current_dir(cwd);
        }
        if self.isolated {
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("GIT_") {
                    command.env_remove(key);
                }
            }
            command
                .env("GIT_OPTIONAL_LOCKS", "0")
                .env("GIT_TERMINAL_PROMPT", "0");
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, Node's `windowsHide`.

        let command_line = std::iter::once(OsStr::new("git"))
            .chain(self.args.iter().copied())
            .map(OsStr::to_string_lossy)
            .collect::<Vec<_>>()
            .join(" ");
        let mut child = command.spawn().map_err(|error| spawn_error(&error))?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let max_buffer = self.max_buffer;
        let run = async {
            let ((stdout, truncated), (stderr, _)) = tokio::join!(
                read_capped(stdout, max_buffer),
                read_capped(stderr, max_buffer)
            );
            if truncated {
                // As `execFile` does once `maxBuffer` is passed.
                let _ = child.start_kill();
            }
            let status = child.wait().await;
            (stdout, stderr, truncated, status)
        };
        let finished = match self.timeout {
            Some(limit) => tokio::time::timeout(limit, run).await.ok(),
            None => Some(run.await),
        };
        let Some((stdout, stderr, truncated, status)) = finished else {
            let _ = child.kill().await;
            return Ok(GitOutput {
                stdout: Vec::new(),
                stderr: Vec::new(),
                exit: Exit::Killed,
                truncated: false,
                timed_out: true,
                command_line,
            });
        };
        let exit = match status {
            Ok(status) => status.code().map_or(Exit::Killed, Exit::Code),
            Err(_) => Exit::Killed,
        };
        Ok(GitOutput {
            stdout,
            stderr,
            exit: if truncated { Exit::Killed } else { exit },
            truncated,
            timed_out: false,
            command_line,
        })
    }

    /// `execFile`'s promise form: the output as text, or its error when Git did not exit 0.
    pub async fn text(self) -> Result<String, CoreError> {
        let output = self.output().await?;
        if output.succeeded() {
            Ok(output.stdout_text())
        } else {
            Err(output.error())
        }
    }
}

impl GitOutput {
    pub fn succeeded(&self) -> bool {
        self.exit == Exit::Code(0) && !self.truncated && !self.timed_out
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// The error `execFile` reports for a run that did not succeed.
    pub fn error(&self) -> CoreError {
        if self.truncated {
            let mut error = CoreError::named("RangeError", "stdout maxBuffer length exceeded");
            error.data = Some(data("code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER".into()));
            return error;
        }
        let mut error = CoreError::new(format!(
            "Command failed: {}\n{}",
            self.command_line,
            String::from_utf8_lossy(&self.stderr)
        ));
        let mut fields = Map::new();
        if let Exit::Code(code) = self.exit {
            fields.insert("code".into(), code.into());
        }
        fields.insert("killed".into(), self.timed_out.into());
        error.data = Some(fields);
        error
    }
}

fn data(key: &str, value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(key.into(), value);
    map
}

/// Node's error when `git` cannot be started, such as `spawn git ENOENT`.
fn spawn_error(error: &std::io::Error) -> CoreError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "EIO",
    };
    let mut core_error = CoreError::new(format!("spawn git {code}"));
    core_error.data = Some(data("code", code.into()));
    core_error
}

/// Reads all of `stream`, keeping at most `cap` bytes. Stops early (closing the pipe) once
/// the cap is passed, so a huge output never sits in memory.
async fn read_capped(mut stream: impl AsyncRead + Unpin, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return (kept, false),
            Ok(read) => {
                if kept.len() + read > cap {
                    kept.extend_from_slice(&chunk[..cap - kept.len()]);
                    return (kept, true);
                }
                kept.extend_from_slice(&chunk[..read]);
            }
        }
    }
}

/// Splits Git's `-z` output on NUL, as `output.split("\0")` does.
pub fn nul_split(output: &str) -> Vec<&str> {
    output.split('\0').collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, future)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::block_on;
    use super::*;

    #[test]
    fn reports_failures_like_exec_file_and_caps_output() {
        block_on(async {
            let output = GitCommand::new(["--definitely-not-an-option"])
                .output()
                .await
                .unwrap();
            assert!(!output.succeeded());
            let error = output.error();
            assert!(error
                .message
                .starts_with("Command failed: git --definitely-not-an-option\n"));
            assert_eq!(error.data.unwrap()["code"], 129);

            let output = GitCommand::new(["--help"])
                .max_buffer(10)
                .output()
                .await
                .unwrap();
            assert!(output.truncated);
            assert_eq!(output.stdout.len(), 10);
        });
    }
}
