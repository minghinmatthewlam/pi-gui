use super::*;
use crate::test_support::temp_dir;
use std::time::Duration;

const OWNER: u64 = 7;

struct Harness {
    terminals: Rc<Terminals>,
    lines: mpsc::UnboundedReceiver<String>,
    workspace: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let (peer, lines) = Peer::new();
        Self {
            terminals: Terminals::new(peer),
            lines,
            workspace: temp_dir("terminal"),
        }
    }

    fn call(&self, method: &str, params: Value) -> CoreResult<Value> {
        self.terminals.call(method, params)
    }

    fn panel(&self, method: &str, scope: &str, shell: &str) -> CoreResult<Value> {
        self.call(
            method,
            json!({
                "ownerId": OWNER,
                "workspaceId": "w1",
                "workspacePath": self.workspace,
                "terminalScopeId": scope,
                "size": { "cols": 80, "rows": 24 },
                "shell": shell,
            }),
        )
    }

    fn write(&self, terminal_id: &str, data: &str) {
        self.call(
            methods::TERMINAL_WRITE,
            json!({ "ownerId": OWNER, "terminalId": terminal_id, "data": data }),
        )
        .unwrap();
    }

    /// Reads notifications until one matches, returning the output seen on the way.
    async fn wait_for(&mut self, matches: impl Fn(&Value) -> bool) -> (Value, String) {
        let mut output = String::new();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), self.lines.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out; output so far: {output:?}"))
                .expect("peer open");
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["method"] == notifications::DATA {
                output.push_str(message["params"]["data"].as_str().unwrap());
            }
            if matches(&message) {
                return (message, output);
            }
        }
    }

    async fn wait_for_output(&mut self, text: &str) -> String {
        let mut seen = String::new();
        while !seen.contains(text) {
            let (_, output) = self
                .wait_for(|message| message["method"] == notifications::DATA)
                .await;
            seen.push_str(&output);
        }
        seen
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.terminals.dispose_all();
        let _ = std::fs::remove_dir_all(&self.workspace);
    }
}

fn run(test: impl std::future::Future<Output = ()>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, test);
}

#[test]
fn a_panel_runs_a_shell_that_echoes_resizes_and_reports_its_exit() {
    run(async {
        let mut harness = Harness::new();
        let panel = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, " thread-1 ", "/bin/sh")
            .unwrap();
        let cwd = harness
            .workspace
            .canonicalize()
            .unwrap()
            .display()
            .to_string();
        assert_eq!(panel["workspaceId"], "w1");
        assert_eq!(panel["rootKey"], format!("{OWNER}\0{cwd}\0thread-1"));
        let session = &panel["sessions"][0];
        let id = session["id"].as_str().unwrap().to_owned();
        assert!(id.starts_with("terminal-") && id.ends_with("-1"), "{id}");
        assert_eq!(panel["activeSessionId"], id);
        assert_eq!(session["title"], "Terminal 1");
        assert_eq!(session["shell"], "/bin/sh");
        assert_eq!(session["cwd"], cwd);
        assert_eq!(session["status"], "running");
        assert!(session.get("exitCode").is_none());

        // The same scope gets the same panel back without another shell.
        let again = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "thread-1", "/bin/sh")
            .unwrap();
        assert_eq!(again["sessions"].as_array().unwrap().len(), 1);

        harness.write(&id, "printf 'PI_%s\\n' TERMINAL_OK; pwd\n");
        let output = harness.wait_for_output(&format!("{cwd}\r\n")).await;
        assert!(output.contains("PI_TERMINAL_OK\r\n"), "{output:?}");

        harness
            .call(
                methods::TERMINAL_RESIZE,
                json!({ "ownerId": OWNER, "terminalId": id, "size": { "cols": 132, "rows": 3 } }),
            )
            .unwrap();
        harness.write(&id, "stty size\n");
        // Rows clamp to at least 4.
        harness.wait_for_output("4 132").await;

        harness.write(&id, "exit 7\n");
        let (exit, _) = harness
            .wait_for(|message| message["method"] == notifications::EXIT)
            .await;
        assert_eq!(
            exit["params"],
            json!({ "ownerId": OWNER, "terminalId": id, "exitCode": 7, "signal": 0 })
        );
        let panel = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "thread-1", "/bin/sh")
            .unwrap();
        let session = &panel["sessions"][0];
        assert_eq!(session["status"], "exited");
        assert_eq!(session["exitCode"], 7);
        assert_eq!(session["signal"], 0);
        assert!(session["replay"]
            .as_str()
            .unwrap()
            .contains("PI_TERMINAL_OK"));

        // Restart starts a fresh shell with an empty replay in the same tab.
        let panel = harness
            .call(
                methods::TERMINAL_RESTART,
                json!({ "ownerId": OWNER, "terminalId": id, "shell": "/bin/sh" }),
            )
            .unwrap();
        let session = &panel["sessions"][0];
        assert_eq!(session["status"], "running");
        assert_eq!(session["replay"], "");
        assert!(session.get("exitCode").is_none());
        harness.write(&id, "echo AFTER_RESTART\n");
        harness.wait_for_output("AFTER_RESTART\r\n").await;
    });
}

#[test]
fn closing_a_running_shell_hangs_it_up_and_moves_to_the_next_tab() {
    run(async {
        let mut harness = Harness::new();
        let first = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "s", "/bin/sh")
            .unwrap()["sessions"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let panel = harness
            .panel(methods::TERMINAL_CREATE_SESSION, "s", "/bin/sh")
            .unwrap();
        let second = panel["sessions"][1]["id"].as_str().unwrap().to_owned();
        assert_eq!(panel["activeSessionId"], second);
        assert_eq!(panel["sessions"][1]["title"], "Terminal 2");
        harness
            .panel(methods::TERMINAL_CREATE_SESSION, "s", "/bin/sh")
            .unwrap();

        harness.write(&second, "echo READY; trap 'echo HUP' HUP\n");
        harness.wait_for_output("READY\r\n").await;
        let panel = harness
            .call(
                methods::TERMINAL_SET_ACTIVE_SESSION,
                json!({ "ownerId": OWNER, "workspaceId": "w1", "terminalScopeId": "s",
                        "terminalId": second }),
            )
            .unwrap();
        assert_eq!(panel["activeSessionId"], second);
        let panel = harness
            .call(
                methods::TERMINAL_CLOSE,
                json!({ "ownerId": OWNER, "terminalId": second }),
            )
            .unwrap();
        // The tab that took its place becomes active.
        assert_eq!(panel["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(panel["activeSessionId"], panel["sessions"][1]["id"]);
        assert_ne!(panel["sessions"][0]["id"], second);

        let closed_last = harness
            .call(
                methods::TERMINAL_CLOSE,
                json!({ "ownerId": OWNER, "terminalId": panel["sessions"][1]["id"] }),
            )
            .unwrap();
        assert_eq!(closed_last["activeSessionId"], first);
        let none = harness
            .call(
                methods::TERMINAL_CLOSE,
                json!({ "ownerId": OWNER, "terminalId": first }),
            )
            .unwrap();
        assert_eq!(none, Value::Null);
        // A closed shell sends nothing more, not even its exit.
        tokio::time::sleep(Duration::from_millis(300)).await;
        while let Ok(line) = harness.lines.try_recv() {
            assert!(!line.contains(notifications::EXIT), "{line}");
        }
    });
}

#[test]
fn calls_check_ownership_limits_and_inputs_with_the_old_messages() {
    run(async {
        let harness = Harness::new();
        let error = |result: CoreResult<Value>| result.unwrap_err().message;
        assert_eq!(
            error(harness.panel(methods::TERMINAL_ENSURE_PANEL, "  ", "/bin/sh")),
            "Terminal scope is required"
        );
        assert_eq!(
            error(harness.call(
                methods::TERMINAL_ENSURE_PANEL,
                json!({ "ownerId": OWNER, "workspaceId": "gone", "workspacePath": null,
                        "terminalScopeId": "s" }),
            )),
            "Unknown workspace: gone"
        );
        let file = harness.workspace.join("file.txt");
        std::fs::write(&file, "").unwrap();
        assert_eq!(
            error(harness.call(
                methods::TERMINAL_ENSURE_PANEL,
                json!({ "ownerId": OWNER, "workspaceId": "w", "workspacePath": file,
                        "terminalScopeId": "s" }),
            )),
            format!("Workspace is not a directory: {}", file.display())
        );
        let missing = harness.workspace.join("missing");
        assert_eq!(
            error(harness.call(
                methods::TERMINAL_ENSURE_PANEL,
                json!({ "ownerId": OWNER, "workspaceId": "w", "workspacePath": missing,
                        "terminalScopeId": "s" }),
            )),
            format!(
                "ENOENT: no such file or directory, stat '{}'",
                missing.display()
            )
        );
        assert_eq!(
            error(harness.panel(methods::TERMINAL_ENSURE_PANEL, "s", "bash")),
            "Integrated terminal shell must be an absolute path: bash"
        );
        assert_eq!(
            error(harness.panel(methods::TERMINAL_ENSURE_PANEL, "s", "/no/such/shell")),
            "ENOENT: no such file or directory, access '/no/such/shell'"
        );

        // The failed tries left an empty panel, which the next call fills.
        let panel = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "s", " /bin/sh ")
            .unwrap();
        let id = panel["sessions"][0]["id"].as_str().unwrap().to_owned();
        // Numbers are used up by failed shells too, as before.
        assert_eq!(panel["sessions"][0]["title"], "Terminal 3");
        for _ in 1..MAX_SESSIONS_PER_ROOT {
            harness
                .panel(methods::TERMINAL_CREATE_SESSION, "s", "/bin/sh")
                .unwrap();
        }
        assert_eq!(
            error(harness.panel(methods::TERMINAL_CREATE_SESSION, "s", "/bin/sh")),
            "A workspace can have up to 8 terminal tabs."
        );

        for method in [methods::TERMINAL_WRITE, methods::TERMINAL_CLOSE] {
            assert_eq!(
                error(harness.call(
                    method,
                    json!({ "ownerId": 99, "terminalId": id, "data": "x" })
                )),
                format!("Unknown terminal session: {id}")
            );
        }
        assert_eq!(
            error(harness.call(
                methods::TERMINAL_SET_ACTIVE_SESSION,
                json!({ "ownerId": OWNER, "workspaceId": "w1", "terminalScopeId": "other",
                        "terminalId": id }),
            )),
            format!("Terminal session {id} does not belong to this thread")
        );

        let title = |title: &str| {
            harness
                .call(
                    methods::TERMINAL_SET_TITLE,
                    json!({ "ownerId": OWNER, "terminalId": id, "title": title }),
                )
                .unwrap();
            harness
                .panel(methods::TERMINAL_ENSURE_PANEL, "s", "/bin/sh")
                .unwrap()["sessions"][0]["title"]
                .clone()
        };
        assert_eq!(title("  user@host: ~/x \n"), "user@host: ~/x");
        assert_eq!(title(&"é".repeat(90)), "é".repeat(80));
        assert_eq!(title(" \t"), "Terminal 3");
    });
}

#[test]
fn a_shell_that_cannot_start_shows_the_error_in_its_tab() {
    run(async {
        let mut harness = Harness::new();
        // A directory passes the executable check but cannot be run.
        let panel = harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "s", "/")
            .unwrap();
        let session = &panel["sessions"][0];
        assert_eq!(session["status"], "error");
        let replay = session["replay"].as_str().unwrap();
        assert!(replay.ends_with("\r\n") && replay.len() > 2, "{replay:?}");
        let (error, _) = harness
            .wait_for(|message| message["method"] == notifications::ERROR)
            .await;
        assert_eq!(error["params"]["terminalId"], session["id"]);
        assert_eq!(
            format!("{}\r\n", error["params"]["message"].as_str().unwrap()),
            replay
        );
    });
}

#[test]
fn removed_folders_and_closed_windows_lose_their_shells() {
    run(async {
        let harness = Harness::new();
        harness
            .panel(methods::TERMINAL_ENSURE_PANEL, "a", "/bin/sh")
            .unwrap();
        let id = harness
            .call(
                methods::TERMINAL_ENSURE_PANEL,
                json!({ "ownerId": 8, "workspaceId": "w1", "workspacePath": harness.workspace,
                        "terminalScopeId": "a", "shell": "/bin/sh" }),
            )
            .unwrap()["sessions"][0]["id"]
            .clone();
        // A folder still open, named by another spelling of its path, keeps its shells.
        harness
            .call(
                methods::TERMINAL_RETAIN_WORKSPACE_PATHS,
                json!({ "workspacePaths": [harness.workspace.join(".")] }),
            )
            .unwrap();
        assert_eq!(harness.terminals.state.borrow().sessions.len(), 2);

        harness
            .call(methods::TERMINAL_DISPOSE_OWNER, json!({ "ownerId": 8 }))
            .unwrap();
        assert_eq!(harness.terminals.state.borrow().sessions.len(), 1);
        assert_eq!(
            harness
                .call(
                    methods::TERMINAL_WRITE,
                    json!({ "ownerId": 8, "terminalId": id, "data": "x" })
                )
                .unwrap_err()
                .message,
            format!("Unknown terminal session: {}", id.as_str().unwrap())
        );

        harness
            .call(
                methods::TERMINAL_RETAIN_WORKSPACE_PATHS,
                json!({ "workspacePaths": ["/elsewhere"] }),
            )
            .unwrap();
        let state = harness.terminals.state.borrow();
        assert!(state.sessions.is_empty() && state.roots.is_empty());
    });
}

#[test]
fn the_replay_keeps_the_last_million_utf16_units() {
    let mut replay = Replay::default();
    replay.append(&"a".repeat(REPLAY_LIMIT - 1));
    replay.append("é");
    assert!(!replay.truncated);
    assert_eq!(replay.utf16_len, REPLAY_LIMIT);
    replay.append("😀b");
    assert!(replay.truncated);
    assert_eq!(replay.utf16_len, REPLAY_LIMIT);
    assert!(replay.text.ends_with("aé😀b"));
    assert_eq!(replay.text.encode_utf16().count(), REPLAY_LIMIT);
    // A cut through an emoji drops all of it.
    let mut replay = Replay::default();
    replay.append(&format!("😀{}", "a".repeat(REPLAY_LIMIT - 1)));
    replay.append("b");
    assert_eq!(replay.text, format!("{}b", "a".repeat(REPLAY_LIMIT - 1)));
    assert_eq!(replay.utf16_len, REPLAY_LIMIT);
}

#[test]
fn output_split_inside_a_character_decodes_whole() {
    let mut decoder = Utf8Stream::default();
    let bytes = "é😀".as_bytes();
    assert_eq!(decoder.decode(&bytes[..1]), "");
    assert_eq!(decoder.decode(&bytes[1..4]), "é");
    assert_eq!(decoder.decode(&bytes[4..]), "😀");
    assert_eq!(decoder.decode(b"a\xffb"), "a\u{FFFD}b");
}

#[test]
fn sizes_ids_and_titles_follow_the_old_rules() {
    let size = |cols: Option<f64>, rows: Option<f64>| normalize_size(SizeParams { cols, rows });
    assert_eq!(size(None, None), Size { cols: 80, rows: 24 });
    assert_eq!(size(Some(9000.7), Some(1.0)), Size { cols: 500, rows: 4 });
    assert_eq!(
        size(Some(99.9), Some(f64::NAN)),
        Size { cols: 99, rows: 24 }
    );
    assert_eq!(base36(0), "0");
    assert_eq!(base36(1_767_225_600_000), "mjuohs00");
    assert_eq!(default_title("terminal-abc-12"), "Terminal 12");
}
