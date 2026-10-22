//! The `pi-gui-core` process Electron main starts. It reads calls on stdin and answers on
//! stdout; only this crate writes to stdout, and diagnostics go to stderr.

fn main() {
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    if let Err(error) = pi_gui_core::run_process(input, tokio::io::stdout()) {
        eprintln!("[pi-gui-core] stopped: {error}");
        std::process::exit(1);
    }
}
