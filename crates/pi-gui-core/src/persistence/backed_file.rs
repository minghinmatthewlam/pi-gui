//! Saved files that keep their previous good version as a `<path>.bak` sibling: UI state,
//! attachments, scheduled tasks and review marks. Same steps, names and messages as
//! `writeFileAtomicQueued` and `readJsonWithBackup` in `electron/persistence/atomic-file-write.ts`.
//! (`catalogs.json` has no backup; it uses the plain write in `atomic.rs`.)
//!
//! The functions here block; callers run them through a [`FileQueue`], which keeps calls for
//! one path in arrival order and off the core's thread.

use crate::error::{CoreError, CoreResult};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A read that may have come from the backup.
#[derive(Debug)]
pub struct BackedRead {
    /// Parsed value, or `None` when neither the file nor its backup was usable.
    pub value: Option<Value>,
    /// The file existed but did not parse.
    pub corrupted: bool,
    /// The value came from `<path>.bak` because the file was missing or damaged.
    pub recovered: bool,
    /// The exact bytes `value` was read from.
    pub contents: Option<Vec<u8>>,
}

enum Parsed {
    Ok(Value, Vec<u8>),
    Missing,
    Corrupt,
}

/// Reads and parses `path`, falling back to its backup when it is missing or damaged. A
/// missing file without a backup is the normal "never written" case and is not corrupt.
pub fn read_json_with_backup(path: &Path) -> CoreResult<BackedRead> {
    let primary = read_parse(path)?;
    if let Parsed::Ok(value, contents) = primary {
        return Ok(BackedRead {
            value: Some(value),
            corrupted: false,
            recovered: false,
            contents: Some(contents),
        });
    }
    let primary_corrupt = matches!(primary, Parsed::Corrupt);
    match read_parse(&sibling(path, ".bak"))? {
        Parsed::Ok(value, contents) => Ok(BackedRead {
            value: Some(value),
            corrupted: primary_corrupt,
            recovered: true,
            contents: Some(contents),
        }),
        backup => Ok(BackedRead {
            value: None,
            corrupted: primary_corrupt || matches!(backup, Parsed::Corrupt),
            recovered: false,
            contents: None,
        }),
    }
}

fn read_parse(path: &Path) -> CoreResult<Parsed> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        Err(error) => return Err(CoreError::io(&error, path)),
    };
    // Like `JSON.parse(buffer.toString("utf8"))`: bad UTF-8 reads as U+FFFD.
    let text = String::from_utf8_lossy(&raw);
    match serde_json::from_str(&crate::json_text::replace_lone_surrogates(&text)) {
        Ok(value) => Ok(Parsed::Ok(value, raw)),
        Err(_) => Ok(Parsed::Corrupt),
    }
}

/// Replaces `path` with `contents` durably. The data already there must read back and pass
/// `validate_existing` first, so the app never overwrites saved data it cannot understand.
/// The previous good file becomes `<path>.bak`; a damaged file that was recovered from the
/// backup is kept as `<path>.corrupt.<uuid>` instead, so the good backup is never replaced by
/// damaged bytes. When `preserve_as` names a path for the validated old data (a migration
/// copy), its exact bytes are written there first, and an existing file there fails the write.
pub fn write_with_backup<T>(
    path: &Path,
    contents: &[u8],
    validate_existing: impl FnOnce(Value) -> CoreResult<T>,
    preserve_as: impl FnOnce(&T) -> Option<PathBuf>,
) -> CoreResult<()> {
    let existing = read_json_with_backup(path)?;
    if existing.corrupted && !existing.recovered {
        return Err(CoreError::new(format!(
            "Cannot overwrite invalid saved data at {}; repair or restore it first.",
            path.display()
        )));
    }
    let validated = existing.value.map(validate_existing).transpose()?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|error| CoreError::io(&error, dir))?;
    let preserved_path = validated.as_ref().and_then(preserve_as);
    if let (Some(preserved_path), Some(old)) = (preserved_path, &existing.contents) {
        // A migration copy is immutable and separate from the rotating backup.
        write_new_file(&preserved_path, old, false)?;
        sync_dir(dir);
    }

    let tmp_path = sibling(
        path,
        &format!(".{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()),
    );
    write_new_file(&tmp_path, contents, true)?;
    if let Err(error) = promote(&tmp_path, path, existing.corrupted) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    sync_dir(dir);
    Ok(())
}

fn write_new_file(path: &Path, contents: &[u8], replace: bool) -> CoreResult<()> {
    let mut options = OpenOptions::new();
    options.write(true);
    if replace {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CoreError::io(&error, path))?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    if let Err(error) = written {
        if replace {
            let _ = fs::remove_file(path);
        }
        return Err(CoreError::io(&error, path));
    }
    Ok(())
}

fn promote(tmp_path: &Path, path: &Path, keep_corrupt: bool) -> CoreResult<()> {
    if keep_corrupt {
        let corrupt = sibling(path, &format!(".corrupt.{}", uuid::Uuid::new_v4()));
        match fs::rename(path, &corrupt) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::io(&error, path)),
        }
    } else {
        // Copy the current file aside, then replace it in one rename: moving it to `.bak`
        // first would leave a moment where readers find no file.
        let backup = sibling(path, ".bak");
        match fs::copy(path, &backup) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::io(&error, &backup)),
        }
    }
    // `fs::rename` replaces an existing file on every platform, Windows included.
    fs::rename(tmp_path, path).map_err(|error| CoreError::io(&error, path))
}

/// Best effort: some platforms (notably Windows) cannot open a folder to sync it.
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// Removes a file, treating a missing one as already removed.
pub fn remove_if_present(path: &Path) -> CoreResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CoreError::io(&error, path)),
    }
}

pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Runs file work for one path at a time, in the order calls arrive, on tokio's blocking
/// threads. Each path's turn is held until its work has really finished, even when the call
/// that started it was cancelled, so two writes to one file never overlap.
#[derive(Default)]
pub struct FileQueue {
    turns: RefCell<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl FileQueue {
    pub async fn run<T: Send + 'static>(
        &self,
        path: &Path,
        work: impl FnOnce() -> CoreResult<T> + Send + 'static,
    ) -> CoreResult<T> {
        let turn = self
            .turns
            .borrow_mut()
            .entry(path.to_owned())
            .or_default()
            .clone();
        // The mutex hands turns out first come, first served.
        let guard = turn.clone().lock_owned().await;
        let done = tokio::task::spawn_blocking(move || {
            let result = work();
            drop(guard);
            result
        })
        .await;
        // Forget the path once nobody else is waiting for it.
        let mut turns = self.turns.borrow_mut();
        if Arc::strong_count(&turn) == 2 {
            turns.remove(path);
        }
        done.map_err(|error| CoreError::new(format!("Saved data work stopped: {error}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn accept(value: Value) -> CoreResult<Value> {
        Ok(value)
    }

    #[test]
    fn rotates_the_previous_file_into_the_backup() {
        let dir = crate::test_support::temp_dir("backed-rotate");
        let path = dir.join("state.json");
        write_with_backup(&path, b"{\"n\":1}\n", accept, |_| None).unwrap();
        assert_eq!(names(&dir), ["state.json"]);
        write_with_backup(&path, b"{\"n\":2}\n", accept, |_| None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"n\":2}\n");
        assert_eq!(fs::read(sibling(&path, ".bak")).unwrap(), b"{\"n\":1}\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recovers_from_the_backup_and_keeps_the_damaged_file_aside() {
        let dir = crate::test_support::temp_dir("backed-recover");
        let path = dir.join("state.json");
        fs::write(&path, "{damaged").unwrap();
        fs::write(sibling(&path, ".bak"), "{\"good\":true}").unwrap();
        let read = read_json_with_backup(&path).unwrap();
        assert!(read.corrupted && read.recovered);
        assert_eq!(read.value, Some(serde_json::json!({ "good": true })));
        write_with_backup(&path, b"{}\n", accept, |_| None).unwrap();
        assert_eq!(
            fs::read_to_string(sibling(&path, ".bak")).unwrap(),
            "{\"good\":true}"
        );
        let corrupt: Vec<_> = names(&dir)
            .into_iter()
            .filter(|name| name.starts_with("state.json.corrupt."))
            .collect();
        assert_eq!(corrupt.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.join(&corrupt[0])).unwrap(),
            "{damaged"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_damaged_data_without_a_backup() {
        let dir = crate::test_support::temp_dir("backed-refuse");
        let path = dir.join("state.json");
        fs::write(&path, "{damaged").unwrap();
        let error = write_with_backup(&path, b"{}", accept, |_| None).unwrap_err();
        assert!(error
            .message
            .starts_with("Cannot overwrite invalid saved data at "));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{damaged");
        let missing = read_json_with_backup(&dir.join("none.json")).unwrap();
        assert!(!missing.corrupted && missing.value.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_taken_migration_copy_path_fails_without_changing_anything() {
        let dir = crate::test_support::temp_dir("backed-migrate");
        let path = dir.join("state.json");
        let copy = dir.join("state.old.json");
        fs::write(&path, "{\"v\":1}").unwrap();
        fs::write(&copy, "earlier").unwrap();
        let error = write_with_backup(&path, b"{}", accept, |_| Some(copy.clone())).unwrap_err();
        assert_eq!(error.data.unwrap()["code"], "EEXIST");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "earlier");
        fs::remove_file(&copy).unwrap();
        write_with_backup(&path, b"{}", accept, |_| Some(copy.clone())).unwrap();
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{\"v\":1}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queued_work_for_one_path_runs_in_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        let order = local.block_on(&runtime, async {
            let queue = std::rc::Rc::new(FileQueue::default());
            let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
            let path = PathBuf::from("/queue/one");
            let tasks: Vec<_> = (0..5)
                .map(|index| {
                    let (queue, seen, path) = (queue.clone(), seen.clone(), path.clone());
                    tokio::task::spawn_local(async move {
                        queue
                            .run(&path, move || {
                                std::thread::sleep(std::time::Duration::from_millis(5 - index));
                                seen.lock().unwrap().push(index);
                                Ok(())
                            })
                            .await
                    })
                })
                .collect();
            for task in tasks {
                task.await.unwrap().unwrap();
            }
            assert!(queue.turns.borrow().is_empty());
            let order = seen.lock().unwrap().clone();
            order
        });
        assert_eq!(order, [0, 1, 2, 3, 4]);
    }
}
