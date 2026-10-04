//! One shell in a pseudo-terminal, through `portable-pty` (ConPTY on Windows). Reads, writes
//! and waiting for exit each block, so each runs on its own thread; the core's executor only
//! sees the events they send.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PtyEvent {
    Output(Vec<u8>),
    /// The output side closed: every process holding the terminal is gone.
    Closed,
    /// The shell exited. `signal` is 0 when it was not killed by one; Windows has none.
    Exited {
        exit_code: i64,
        signal: Option<i64>,
    },
}

pub struct Pty {
    master: Box<dyn MasterPty>,
    input: std_mpsc::Sender<Vec<u8>>,
    pid: Option<u32>,
    /// Set by the waiter thread once the shell is reaped, so a recycled pid is never signalled.
    exited: Arc<AtomicBool>,
    #[cfg(windows)]
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

const READ_BUFFER_BYTES: usize = 64 * 1024;

/// Starts `shell` (no arguments) in `cwd` with the app's environment, as node-pty did.
pub fn spawn(
    shell: &str,
    cwd: &str,
    size: Size,
) -> Result<(Pty, mpsc::UnboundedReceiver<PtyEvent>), String> {
    let pair = native_pty_system()
        .openpty(pty_size(size))
        .map_err(|error| format!("{error:#}"))?;
    #[cfg(unix)]
    if let Some(fd) = pair.master.as_raw_fd() {
        use_node_pty_input_flags(fd);
    }

    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        // A terminfo path from the app's own environment can point xterm-256color at the
        // wrong entry.
        if key == "TERMINFO" || key == "TERMINFO_DIRS" {
            continue;
        }
        command.env(key, value);
    }
    command.env("TERM", "xterm-256color");
    #[cfg(unix)]
    command.env("PWD", cwd);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("{error:#}"))?;
    // Only the shell may hold the terminal's other end, or reads never see it close.
    drop(pair.slave);
    let pid = child.process_id();
    #[cfg(windows)]
    let killer = child.clone_killer();

    let (events_tx, events) = mpsc::unbounded_channel();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("{error:#}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("{error:#}"))?;
    let (input, input_rx) = std_mpsc::channel();
    let exited = Arc::new(AtomicBool::new(false));

    let pty = Pty {
        master: pair.master,
        input,
        pid,
        exited: exited.clone(),
        #[cfg(windows)]
        killer,
    };
    let output_tx = events_tx.clone();
    start_thread("pi-gui-pty-read", move || read_output(reader, output_tx))?;
    start_thread("pi-gui-pty-write", move || write_input(writer, input_rx))?;
    start_thread("pi-gui-pty-wait", move || {
        let (exit_code, signal) = wait_for_exit(child);
        exited.store(true, Ordering::SeqCst);
        let _ = events_tx.send(PtyEvent::Exited { exit_code, signal });
    })?;
    Ok((pty, events))
}

impl Pty {
    /// Queues input for the shell. Writes never block the caller, even when the shell is not
    /// reading and the terminal's input buffer is full.
    pub fn write(&self, data: &[u8]) {
        let _ = self.input.send(data.to_vec());
    }

    pub fn resize(&self, size: Size) -> Result<(), String> {
        self.master
            .resize(pty_size(size))
            .map_err(|error| format!("{error:#}"))
    }
}

impl Drop for Pty {
    /// Hangs up the shell and everything it started, unless it already exited.
    fn drop(&mut self) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) {
            if pid > 0 {
                // The shell leads its own process group; fall back to the shell alone.
                unsafe {
                    libc::kill(-pid, libc::SIGHUP);
                    libc::kill(pid, libc::SIGHUP);
                }
            }
        }
        #[cfg(windows)]
        {
            let _ = self.pid;
            let _ = self.killer.kill();
        }
    }
}

fn pty_size(size: Size) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn start_thread(name: &str, run: impl FnOnce() + Send + 'static) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(run)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn read_output(mut reader: Box<dyn Read + Send>, events: mpsc::UnboundedSender<PtyEvent>) {
    let mut buffer = vec![0; READ_BUFFER_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if events
                    .send(PtyEvent::Output(buffer[..read].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            // Linux reports EIO once the last process holding the terminal exits.
            Err(_) => break,
        }
    }
    let _ = events.send(PtyEvent::Closed);
}

fn write_input(mut writer: Box<dyn Write + Send>, input: std_mpsc::Receiver<Vec<u8>>) {
    for data in input {
        if writer
            .write_all(&data)
            .and_then(|_| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Waits for the shell and reports its exit the way node-pty did: on Unix the exit status
/// and the number of the signal that ended it (0 for none).
fn wait_for_exit(child: Box<dyn Child + Send + Sync>) -> (i64, Option<i64>) {
    #[cfg(unix)]
    if let Some(pid) = child.process_id() {
        let pid = pid as libc::pid_t;
        let mut status: libc::c_int = 0;
        loop {
            let result = unsafe { libc::waitpid(pid, &mut status, 0) };
            if result == pid {
                break;
            }
            if result == -1
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            return (0, Some(0));
        }
        let exit_code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            0
        };
        let signal = if libc::WIFSIGNALED(status) {
            libc::WTERMSIG(status)
        } else {
            0
        };
        return (i64::from(exit_code), Some(i64::from(signal)));
    }
    let mut child = child;
    match child.wait() {
        Ok(status) => (i64::from(status.exit_code()), None),
        Err(_) => (1, None),
    }
}

/// node-pty set these input flags on every terminal it opened; IUTF8 matters most, so
/// erasing a multi-byte character in a line being typed removes the whole character.
#[cfg(unix)]
fn use_node_pty_input_flags(fd: std::os::unix::io::RawFd) {
    unsafe {
        let mut termios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut termios) == 0 {
            termios.c_iflag |= libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8;
            libc::tcsetattr(fd, libc::TCSANOW, &termios);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Collects output until `until` matches or the shell closes the terminal.
    async fn read_until(
        events: &mut mpsc::UnboundedReceiver<PtyEvent>,
        output: &mut String,
        until: impl Fn(&str) -> bool,
    ) -> Vec<PtyEvent> {
        let mut other = Vec::new();
        while !until(output) {
            match tokio::time::timeout(Duration::from_secs(10), events.recv()).await {
                Ok(Some(PtyEvent::Output(bytes))) => {
                    output.push_str(&String::from_utf8_lossy(&bytes))
                }
                Ok(Some(event)) => other.push(event),
                Ok(None) => break,
                Err(_) => panic!("timed out; output so far: {output:?}"),
            }
        }
        other
    }

    #[tokio::test]
    async fn runs_a_shell_that_reads_input_resizes_and_exits_with_its_code() {
        let dir = crate::test_support::temp_dir("pty");
        let cwd = dir.canonicalize().unwrap().display().to_string();
        let (pty, mut events) = spawn("/bin/sh", &cwd, Size { cols: 80, rows: 24 }).unwrap();
        let mut output = String::new();

        pty.write(b"echo \"$TERM:$PWD\"; pwd\n");
        read_until(&mut events, &mut output, |text| {
            text.contains(&format!("xterm-256color:{cwd}\r\n{cwd}\r\n"))
        })
        .await;

        pty.resize(Size {
            cols: 120,
            rows: 40,
        })
        .unwrap();
        pty.write(b"stty size\n");
        read_until(&mut events, &mut output, |text| text.contains("40 120")).await;

        pty.write(b"exit 3\n");
        let mut rest = read_until(&mut events, &mut output, |_| false).await;
        rest.extend(std::iter::from_fn(|| events.try_recv().ok()));
        assert!(rest.contains(&PtyEvent::Exited {
            exit_code: 3,
            signal: Some(0)
        }));
        assert!(rest.contains(&PtyEvent::Closed));
        drop(pty);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn dropping_a_running_shell_hangs_it_up() {
        let (pty, mut events) = spawn("/bin/sh", "/", Size { cols: 80, rows: 24 }).unwrap();
        let mut output = String::new();
        pty.write(b"echo READY\n");
        read_until(&mut events, &mut output, |text| text.contains("READY\r\n")).await;
        drop(pty);
        let exit = loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv()).await {
                Ok(Some(PtyEvent::Exited { exit_code, signal })) => break (exit_code, signal),
                Ok(Some(_)) => {}
                other => panic!("no exit: {other:?}"),
            }
        };
        assert_eq!(exit, (0, Some(i64::from(libc::SIGHUP))));
    }
}
