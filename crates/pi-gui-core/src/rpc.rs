//! The wire format shared with `apps/desktop/pi-host/rpc-peer.ts`: one JSON message per line.
//! A request is `{ id, method, params? }`, a reply `{ id, result }` or `{ id, error }`, and a
//! notification has no `id`. Calls are answered one at a time in arrival order, so a change
//! is always visible to every call that arrives after it.

use crate::error::CoreError;
use crate::Core;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct Incoming {
    id: Option<u64>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

/// Serves calls from `input` until it closes or the app asks the core to shut down.
pub fn serve(core: &mut Core, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Incoming>(
            &crate::json_text::replace_lone_surrogates(line),
        ) {
            Ok(message) => message,
            Err(error) => {
                // A call the core cannot read still gets an answer, or its caller would wait
                // forever. The app always writes `id` first.
                if let Some(id) = leading_id(line) {
                    let reply = json!({
                        "id": id,
                        "error": CoreError::new(format!("Could not read the call: {error}")),
                    });
                    writeln!(output, "{reply}")?;
                    output.flush()?;
                } else {
                    eprintln!(
                        "[pi-gui-core] ignored a line that is not a message: {}",
                        line.chars().take(200).collect::<String>()
                    );
                }
                continue;
            }
        };
        let (Some(id), Some(method)) = (message.id, message.method) else {
            // Notifications (such as `$/cancel`) and stray replies need no answer: calls run
            // to completion before the next line is read, so there is nothing to cancel.
            continue;
        };
        let reply = match core.dispatch(&method, message.params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        let encoded = serde_json::to_string(&reply).unwrap_or_else(|error| {
            serde_json::to_string(&json!({
                "id": id,
                "error": CoreError::new(format!("Could not encode the reply: {error}")),
            }))
            .expect("an error reply always encodes")
        });
        writeln!(output, "{encoded}")?;
        output.flush()?;
        if core.shutting_down() {
            break;
        }
    }
    Ok(())
}

fn leading_id(line: &str) -> Option<u64> {
    let rest = line.strip_prefix("{\"id\":")?;
    let end = rest.find(|c: char| !c.is_ascii_digit())?;
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Vec<Value> {
        let mut core = Core::new();
        let mut output = Vec::new();
        serve(&mut core, input.as_bytes(), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn answers_in_order_skips_noise_and_stops_on_shutdown() {
        let dir = crate::test_support::temp_dir("rpc");
        let input = format!(
            "Debugger attached\n{}\n{}\n{}\n{}\n{}\n",
            json!({ "id": 1, "method": "core.initialize", "params": { "userDataDir": dir } }),
            json!({ "method": "$/cancel", "params": { "id": 1 } }),
            json!({ "id": 2, "method": "catalog.call",
                    "params": { "path": "sessions.listSessions", "args": [] } }),
            json!({ "id": 3, "method": "nope" }),
            json!({ "id": 4, "method": "core.shutdown" }),
        ) + &json!({ "id": 5, "method": "core.shutdown" }).to_string();
        let replies = run(&input);
        assert_eq!(replies.len(), 4);
        assert_eq!(replies[0], json!({ "id": 1, "result": null }));
        assert_eq!(
            replies[1],
            json!({ "id": 2, "result": { "value": { "sessions": [] } } })
        );
        assert_eq!(replies[2]["error"]["message"], "Unknown RPC method: nope");
        assert_eq!(replies[3], json!({ "id": 4, "result": null }));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_call_that_cannot_be_read_still_gets_an_error_reply() {
        let replies = run("{\"id\":7,\"method\":\"catalog.call\",\"params\":{\"bad\n");
        assert_eq!(replies[0]["id"], 7);
        assert!(replies[0]["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Could not read the call"));
    }

    #[test]
    fn catalog_calls_before_initialize_fail_cleanly() {
        let replies = run(&format!(
            "{}\n",
            json!({ "id": 1, "method": "catalog.call", "params": { "path": "getSessionFile" } })
        ));
        assert_eq!(
            replies[0]["error"]["message"],
            "pi-gui core is not initialized"
        );
    }
}
