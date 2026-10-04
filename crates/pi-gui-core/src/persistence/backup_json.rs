//! JSON files kept with a `.bak` copy of the previous good version, read and written the way
//! `readJsonWithBackup` and `writeFileAtomicQueued` in `electron/persistence/atomic-file-write.ts`
//! did, so files either side wrote load on the other. Used by turn checkpoints, ui-state,
//! attachments, scheduled tasks and review marks (`catalogs.json` has no backup; it uses the
//! plain write in `atomic.rs`).
//!
//! The functions here block. Callers run them off the core's thread, through a [`FileQueue`]
//! when calls for one file must not overlap.

use crate::error::{CoreError, CoreResult};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct BackupRead {
    /// The parsed value, or `None` when neither the file nor its backup was usable.
    pub value: Option<Value>,
    /// The file existed but did not parse.
    pub corrupted: bool,
    /// The value came from the `.bak` copy.
    pub recovered: bool,
    /// The exact bytes `value` was read from.
    pub contents: Option<Vec<u8>>,
}

enum Parsed {
    Ok(Value, Vec<u8>),
    Missing,
    Corrupt,
}

fn read_parse(path: &Path) -> CoreResult<Parsed> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        Err(error) => return Err(CoreError::io(&error, path)),
    };
    // Like `JSON.parse(buffer.toString("utf8"))`: bad UTF-8 reads as U+FFFD.
    let text = String::from_utf8_lossy(&raw);
    Ok(
        match serde_json::from_str(&crate::json_text::replace_lone_surrogates(&text)) {
            Ok(value) => Parsed::Ok(value, raw),
            Err(_) => Parsed::Corrupt,
        },
    )
}

pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Reads `path`, falling back to its `.bak` copy when it is missing or does not parse. A
/// missing file without a backup is the normal "never written" case and is not corrupt.
pub fn read_json_with_backup(path: &Path) -> CoreResult<BackupRead> {
    let primary = read_parse(path)?;
    if let Parsed::Ok(value, contents) = primary {
        return Ok(BackupRead {
            value: Some(value),
            corrupted: false,
            recovered: false,
            contents: Some(contents),
        });
    }
    let primary_corrupt = matches!(primary, Parsed::Corrupt);
    match read_parse(&sibling(path, ".bak"))? {
        Parsed::Ok(value, contents) => Ok(BackupRead {
            value: Some(value),
            corrupted: primary_corrupt,
            recovered: true,
            contents: Some(contents),
        }),
        backup => Ok(BackupRead {
            value: None,
            corrupted: primary_corrupt || matches!(backup, Parsed::Corrupt),
            recovered: false,
            contents: None,
        }),
    }
}

/// Replaces `path` with `contents` durably, first copying the current good file to `.bak`.
/// A file that exists but `validate_existing` rejects is never overwritten, and a damaged
/// file is moved aside to `.corrupt.<id>` instead of becoming the backup.
pub fn write_with_backup(
    path: &Path,
    contents: &str,
    validate_existing: impl FnOnce(&Value) -> CoreResult<()>,
) -> CoreResult<()> {
    write_with_migration_copy(path, contents, validate_existing, |_| None)
}

/// [`write_with_backup`], and when `preserve_as` names a path for the validated old data (a
/// migration copy), its exact bytes are written there first. The copy is never replaced: an
/// existing file at that path fails the write with `EEXIST` before anything changes.
pub fn write_with_migration_copy<T>(
    path: &Path,
    contents: &str,
    validate_existing: impl FnOnce(&Value) -> CoreResult<T>,
    preserve_as: impl FnOnce(&T) -> Option<PathBuf>,
) -> CoreResult<()> {
    let existing = read_json_with_backup(path)?;
    if existing.corrupted && !existing.recovered {
        return Err(CoreError::new(format!(
            "Cannot overwrite invalid saved data at {}; repair or restore it first.",
            path.display()
        )));
    }
    let validated = existing.value.as_ref().map(validate_existing).transpose()?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|error| CoreError::io(&error, dir))?;
    let preserved_path = validated.as_ref().and_then(preserve_as);
    if let (Some(preserved_path), Some(old)) = (preserved_path, &existing.contents) {
        write_file(&preserved_path, old, false)?;
        sync_dir(dir);
    }
    let tmp_path = sibling(
        path,
        &format!(".{}.{}.tmp", std::process::id(), crate::random_id()),
    );
    write_file(&tmp_path, contents.as_bytes(), true)?;
    if let Err(error) = promote(&tmp_path, path, existing.corrupted) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    sync_dir(dir);
    Ok(())
}

/// Writes and syncs a file. `replace` false creates it only if nothing is there yet.
fn write_file(path: &Path, contents: &[u8], replace: bool) -> CoreResult<()> {
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
    if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
        if replace {
            let _ = fs::remove_file(path);
        }
        return Err(CoreError::io(&error, path));
    }
    Ok(())
}

fn promote(tmp_path: &Path, path: &Path, keep_corrupt: bool) -> CoreResult<()> {
    let ignore_missing = |result: io::Result<()>, at: &Path| match result {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(CoreError::io(&error, at)),
        _ => Ok(()),
    };
    if keep_corrupt {
        // Recovery never replaces the good backup with damaged bytes.
        let aside = sibling(path, &format!(".corrupt.{}", crate::random_id()));
        ignore_missing(fs::rename(path, &aside), path)?;
    } else {
        // Copy, not move, so a reader never finds the file missing.
        let backup = sibling(path, ".bak");
        ignore_missing(fs::copy(path, &backup).map(|_| ()), path)?;
    }
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
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(CoreError::io(&error, path)),
        _ => Ok(()),
    }
}

/// Runs file work for one path at a time, in the order calls arrive, on tokio's blocking
/// threads, like the per-path write queue in `atomic-file-write.ts`. A path's turn is held
/// until its work has really finished, even when the call that started it was cancelled, so
/// two writes to one file never overlap.
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

    #[test]
    fn keeps_a_backup_and_recovers_from_it() {
        let dir = crate::test_support::temp_dir("backup-json");
        let path = dir.join("state.json");
        let accept = |_: &Value| Ok(());
        write_with_backup(&path, "{\"n\":1}\n", accept).unwrap();
        write_with_backup(&path, "{\"n\":2}\n", accept).unwrap();
        assert_eq!(
            fs::read_to_string(sibling(&path, ".bak")).unwrap(),
            "{\"n\":1}\n"
        );
        fs::write(&path, "{broken").unwrap();
        let read = read_json_with_backup(&path).unwrap();
        assert_eq!(read.value, Some(serde_json::json!({ "n": 1 })));
        assert!(read.corrupted && read.recovered);
        write_with_backup(&path, "{\"n\":3}\n", accept).unwrap();
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        let corrupt: Vec<_> = names
            .iter()
            .filter(|name| name.starts_with("state.json.corrupt."))
            .collect();
        assert_eq!(corrupt.len(), 1);
        assert_eq!(fs::read_to_string(dir.join(corrupt[0])).unwrap(), "{broken");
        assert_eq!(
            fs::read_to_string(sibling(&path, ".bak")).unwrap(),
            "{\"n\":1}\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_to_replace_a_file_it_cannot_read_or_validate() {
        let dir = crate::test_support::temp_dir("backup-json-refuse");
        let path = dir.join("state.json");
        fs::write(&path, "{broken").unwrap();
        let error = write_with_backup(&path, "{}\n", |_| Ok(())).unwrap_err();
        assert!(error
            .message
            .starts_with("Cannot overwrite invalid saved data"));
        fs::write(&path, "{\"version\":9}").unwrap();
        let error =
            write_with_backup(&path, "{}\n", |_| Err(CoreError::new("unsupported"))).unwrap_err();
        assert_eq!(error.message, "unsupported");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"version\":9}");
        let missing = read_json_with_backup(&dir.join("none.json")).unwrap();
        assert!(!missing.corrupted && missing.value.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_taken_migration_copy_path_fails_without_changing_anything() {
        let dir = crate::test_support::temp_dir("backup-json-migrate");
        let path = dir.join("state.json");
        let copy = dir.join("state.old.json");
        let accept = |_: &Value| Ok(());
        fs::write(&path, "{\"v\":1}").unwrap();
        fs::write(&copy, "earlier").unwrap();
        let error =
            write_with_migration_copy(&path, "{}", accept, |_| Some(copy.clone())).unwrap_err();
        assert_eq!(error.data.unwrap()["code"], "EEXIST");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "earlier");
        fs::remove_file(&copy).unwrap();
        write_with_migration_copy(&path, "{}", accept, |_| Some(copy.clone())).unwrap();
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
