//! Durable file writes: a reader or a crash always sees the old file or the whole new one.
//! The one temp-file-and-rename writer behind `catalogs.json` and the backed-up files in
//! `backup_json.rs`.

use crate::error::{CoreError, CoreResult};
use crate::js;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Writes `data` to a unique temp file next to `path`, syncs it, renames it over `path`,
/// then syncs the folder so the rename itself survives power loss. Same steps and
/// guarantees as `writeFileAtomic` in `@pi-gui/catalogs`.
pub fn write_file_atomic(path: &Path, data: &[u8]) -> CoreResult<()> {
    replace_file(path, data, || Ok(()))
}

/// `writeJsonFileAtomic`: `JSON.stringify(value, null, 2)` and a trailing newline.
pub fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> CoreResult<()> {
    let value = serde_json::to_value(value)
        .map_err(|error| CoreError::new(format!("Could not encode {}: {error}", path.display())))?;
    write_file_atomic(
        path,
        format!("{}\n", js::stringify_pretty(&value)).as_bytes(),
    )
}

/// [`write_file_atomic`], running `before_rename` once the new bytes are safely on disk and
/// just before they replace `path`. Its error fails the write and leaves `path` as it was.
pub(crate) fn replace_file(
    path: &Path,
    data: &[u8],
    before_rename: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
    let dir = parent(path);
    fs::create_dir_all(dir).map_err(|error| CoreError::io(&error, dir))?;
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        crate::random_id()
    ));
    let tmp_path = PathBuf::from(tmp_name);
    write_new_file(&tmp_path, data)?;
    let replaced = before_rename()
        .and_then(|()| fs::rename(&tmp_path, path).map_err(|error| CoreError::io(&error, path)));
    if let Err(error) = replaced {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    sync_dir(dir);
    Ok(())
}

/// Creates `path` (failing with `EEXIST` when something is already there), writes `data` and
/// syncs it. A failed write removes the partial file, which this call created.
pub(crate) fn write_new_file(path: &Path, data: &[u8]) -> CoreResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| CoreError::io(&error, path))?;
    if let Err(error) = file.write_all(data).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CoreError::io(&error, path));
    }
    Ok(())
}

pub(crate) fn parent(path: &Path) -> &Path {
    path.parent().unwrap_or_else(|| Path::new("."))
}

/// Best effort: some platforms (notably Windows) cannot open a folder to sync it.
pub(crate) fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_file_and_leaves_no_temp_files() {
        let dir = crate::test_support::temp_dir("atomic");
        let path = dir.join("nested").join("state.json");
        write_file_atomic(&path, b"one").unwrap();
        write_file_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let error = replace_file(&path, b"three", || Err(CoreError::new("no"))).unwrap_err();
        assert_eq!(error.message, "no");
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn json_matches_javascript_pretty_printing() {
        let dir = crate::test_support::temp_dir("atomic-json");
        let path = dir.join("value.json");
        write_json_atomic(
            &path,
            &serde_json::json!({ "version": 2, "list": [], "map": {}, "n": 3, "big": 1e21 }),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"version\": 2,\n  \"list\": [],\n  \"map\": {},\n  \"n\": 3,\n  \"big\": 1e+21\n}\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
