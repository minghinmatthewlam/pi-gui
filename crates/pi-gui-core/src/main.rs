//! The `pi-gui-core` process Electron main starts. It reads calls on stdin and answers on
//! stdout; only this crate writes to stdout, and diagnostics go to stderr.

fn main() {
    let mut core = pi_gui_core::Core::new();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if let Err(error) = pi_gui_core::rpc::serve(&mut core, stdin.lock(), stdout.lock()) {
        eprintln!("[pi-gui-core] stopped: {error}");
        std::process::exit(1);
    }
}
