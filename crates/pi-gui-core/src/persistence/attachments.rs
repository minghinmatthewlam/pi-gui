//! Composer attachments, one file per thread under `attachments/`, named by the URI-encoded
//! session key. Same format, checks and messages as the old `AttachmentStore`.

use super::backed_file::{read_json_with_backup, remove_if_present, sibling, write_with_backup};
use crate::error::{CoreError, CoreResult};
use crate::js;
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn file_path(root: &Path, session_key: &str) -> PathBuf {
    root.join(format!("{}.json", js::encode_uri_component(session_key)))
}

/// The saved attachments, or `None` when the thread has none saved.
pub fn read(root: &Path, session_key: &str) -> CoreResult<Option<Value>> {
    let path = file_path(root, session_key);
    let result = read_json_with_backup(&path)?;
    if result.corrupted && !result.recovered {
        return Err(CoreError::new(format!(
            "Invalid saved attachments at {}; original data was retained.",
            path.display()
        )));
    }
    if result.corrupted {
        eprintln!(
            "[attachment-store] corrupt entry for \"{session_key}\" in {} — recovered from backup",
            root.display()
        );
    }
    result.value.map(|value| decode(&value)).transpose()
}

pub fn write(root: &Path, session_key: &str, attachments: &Value) -> CoreResult<()> {
    decode(attachments)?;
    let contents = format!("{}\n", js::stringify_pretty(attachments));
    write_with_backup(
        &file_path(root, session_key),
        contents.as_bytes(),
        |existing| decode(&existing),
        |_| None,
    )
}

/// The session keys with saved attachments. A file name that does not decode is skipped,
/// so one stray file cannot stop pruning for every thread.
pub fn list_keys(root: &Path) -> CoreResult<Vec<String>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(CoreError::io(&error, root)),
    };
    let mut keys = Vec::new();
    for entry in entries {
        let name = entry
            .map_err(|error| CoreError::io(&error, root))?
            .file_name()
            .to_string_lossy()
            .into_owned();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        match js::decode_uri_component(stem) {
            Some(key) => keys.push(key),
            None => eprintln!(
                "[attachment-store] skipping malformed filename \"{name}\" in {} URIError: URI malformed",
                root.display()
            ),
        }
    }
    Ok(keys)
}

/// Deletes a thread's attachments and their backup. Saved data that does not read back
/// cleanly is never pruned.
pub fn remove(root: &Path, session_key: &str) -> CoreResult<()> {
    let path = file_path(root, session_key);
    if read_json_with_backup(&path)?.corrupted {
        return Err(CoreError::new(format!(
            "Cannot prune corrupt saved attachments at {}; original data was retained.",
            path.display()
        )));
    }
    read(root, session_key)?;
    remove_if_present(&path)?;
    remove_if_present(&sibling(&path, ".bak"))
}

/// `decodeAttachments`: checks every entry and returns them in their canonical shape.
pub fn decode(value: &Value) -> CoreResult<Value> {
    let Value::Array(items) = value else {
        return Err(CoreError::new(
            "Invalid saved attachments: expected an array; original data was retained.",
        ));
    };
    items
        .iter()
        .enumerate()
        .map(|(index, entry)| decode_one(index, entry))
        .collect::<CoreResult<Vec<_>>>()
        .map(Value::Array)
}

fn decode_one(index: usize, entry: &Value) -> CoreResult<Value> {
    let Value::Object(item) = entry else {
        return Err(CoreError::new(format!(
            "Invalid saved attachment at index {index}."
        )));
    };
    let field = |key: &str| item.get(key).and_then(Value::as_str);
    let (Some(id), Some(name), Some(mime_type)) = (field("id"), field("name"), field("mimeType"))
    else {
        return Err(CoreError::new(format!(
            "Invalid saved attachment metadata at index {index}."
        )));
    };
    let is_file = item.get("kind") == Some(&json!("file"));
    let allowed: &[&str] = if is_file {
        &["id", "kind", "name", "mimeType", "fsPath", "sizeBytes"]
    } else {
        &["id", "kind", "name", "mimeType", "data"]
    };
    if item.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(CoreError::new(format!(
            "Invalid saved attachment at index {index}: unsupported field; original data was retained."
        )));
    }
    let mut decoded = Map::new();
    decoded.insert("id".into(), json!(id));
    decoded.insert("name".into(), json!(name));
    decoded.insert("mimeType".into(), json!(mime_type));
    let image_kind = item.get("kind").is_none() || item.get("kind") == Some(&json!("image"));
    if let (true, Some(data)) = (image_kind, field("data")) {
        decoded.insert("kind".into(), json!("image"));
        decoded.insert("data".into(), json!(data));
        return Ok(Value::Object(decoded));
    }
    let size = item.get("sizeBytes");
    let size_ok = match size {
        None => true,
        Some(value) => value
            .as_f64()
            .is_some_and(|size| size.is_finite() && size >= 0.0),
    };
    if let (true, Some(fs_path), true) = (is_file, field("fsPath"), size_ok) {
        decoded.insert("kind".into(), json!("file"));
        decoded.insert("fsPath".into(), json!(fs_path));
        if let Some(size) = size {
            decoded.insert("sizeBytes".into(), size.clone());
        }
        return Ok(Value::Object(decoded));
    }
    Err(CoreError::new(format!(
        "Invalid saved attachment payload at index {index}; original data was retained."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_images_files_and_legacy_entries_without_a_kind() {
        let decoded = decode(&json!([
            { "id": "a", "name": "a.png", "mimeType": "image/png", "data": "eA==" },
            { "id": "b", "kind": "file", "name": "b", "mimeType": "text/plain", "fsPath": "/b",
              "sizeBytes": 3 },
        ]))
        .unwrap();
        assert_eq!(
            decoded,
            json!([
                { "id": "a", "name": "a.png", "mimeType": "image/png", "kind": "image", "data": "eA==" },
                { "id": "b", "name": "b", "mimeType": "text/plain", "kind": "file", "fsPath": "/b",
                  "sizeBytes": 3 },
            ])
        );
        let messages: Vec<String> = [
            json!({}),
            json!([null]),
            json!([{ "id": "a", "name": "a" }]),
            json!([{ "id": "a", "name": "a", "mimeType": "m", "data": "", "extra": 1 }]),
            json!([{ "id": "a", "name": "a", "mimeType": "m", "kind": "file", "fsPath": "/a",
                     "sizeBytes": -1 }]),
        ]
        .iter()
        .map(|value| decode(value).unwrap_err().message)
        .collect();
        assert_eq!(
            messages,
            [
                "Invalid saved attachments: expected an array; original data was retained.",
                "Invalid saved attachment at index 0.",
                "Invalid saved attachment metadata at index 0.",
                "Invalid saved attachment at index 0: unsupported field; original data was retained.",
                "Invalid saved attachment payload at index 0; original data was retained.",
            ]
        );
    }

    #[test]
    fn writes_lists_and_removes_by_encoded_key() {
        let dir = crate::test_support::temp_dir("attachments");
        let root = dir.join("attachments");
        assert!(list_keys(&root).unwrap().is_empty());
        let value = json!([{ "id": "a", "name": "a", "mimeType": "m", "data": "x" }]);
        write(&root, "ws:sess one", &value).unwrap();
        write(&root, "ws:sess one", &value).unwrap();
        assert!(root.join("ws%3Asess%20one.json").exists());
        assert!(root.join("ws%3Asess%20one.json.bak").exists());
        fs::write(root.join("%E0%A4%A.json"), "[]").unwrap();
        assert_eq!(list_keys(&root).unwrap(), ["ws:sess one"]);
        remove(&root, "ws:sess one").unwrap();
        assert!(read(&root, "ws:sess one").unwrap().is_none());
        assert!(!root.join("ws%3Asess%20one.json.bak").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
