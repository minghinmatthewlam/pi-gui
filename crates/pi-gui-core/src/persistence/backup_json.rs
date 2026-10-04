//! JSON files kept with a `.bak` copy of the previous good version, read and written the way
//! `readJsonWithBackup` and `writeFileAtomicQueued` in `electron/persistence/atomic-file-write.ts`
//! do, so files either side wrote load on the other.

use crate::error::{CoreError, CoreResult};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct BackupRead {
    /// The parsed value, or `None` when neither the file nor its backup was usable.
    pub value: Option<Value>,
    /// The file existed but did not parse.
    pub corrupted: bool,
    /// The value came from the `.bak` copy.
    pub recovered: bool,
}

enum Parsed {
    Ok(Value),
    Missing,
    Corrupt,
}

fn read_parse(path: &Path) -> CoreResult<Parsed> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        Err(error) => return Err(CoreError::io(&error, path)),
    };
    let text = String::from_utf8_lossy(&raw);
    Ok(
        match serde_json::from_str(&crate::json_text::replace_lone_surrogates(&text)) {
            Ok(value) => Parsed::Ok(value),
            Err(_) => Parsed::Corrupt,
        },
    )
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Reads `path`, falling back to its `.bak` copy when it is missing or does not parse.
pub fn read_json_with_backup(path: &Path) -> CoreResult<BackupRead> {
    let primary = read_parse(path)?;
    if let Parsed::Ok(value) = primary {
        return Ok(BackupRead {
            value: Some(value),
            corrupted: false,
            recovered: false,
        });
    }
    let primary_corrupt = matches!(primary, Parsed::Corrupt);
    match read_parse(&sibling(path, ".bak"))? {
        Parsed::Ok(value) => Ok(BackupRead {
            value: Some(value),
            corrupted: primary_corrupt,
            recovered: true,
        }),
        backup => Ok(BackupRead {
            value: None,
            corrupted: primary_corrupt || matches!(backup, Parsed::Corrupt),
            recovered: false,
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
    let existing = read_json_with_backup(path)?;
    if existing.corrupted && !existing.recovered {
        return Err(CoreError::new(format!(
            "Cannot overwrite invalid saved data at {}; repair or restore it first.",
            path.display()
        )));
    }
    if let Some(value) = &existing.value {
        validate_existing(value)?;
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|error| CoreError::io(&error, dir))?;
    let tmp_path = sibling(
        path,
        &format!(".{}.{}.tmp", std::process::id(), crate::random_id()),
    );
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp_path);
        return Err(CoreError::io(&error, &tmp_path));
    }
    if let Err(error) = promote(&tmp_path, path, existing.corrupted) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    // Best effort: some platforms (notably Windows) cannot open a folder to sync it.
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
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
        assert!(names
            .iter()
            .any(|name| name.starts_with("state.json.corrupt.")));
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
        fs::remove_dir_all(dir).unwrap();
    }
}
