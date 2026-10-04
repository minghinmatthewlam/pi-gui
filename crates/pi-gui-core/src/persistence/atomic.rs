//! Durable file writes: a reader or a crash always sees the old file or the whole new one.

use crate::error::{CoreError, CoreResult};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Writes `data` to a unique temp file next to `path`, syncs it, renames it over `path`,
/// then syncs the folder so the rename itself survives power loss. Same steps, temp file
/// naming and guarantees as `writeFileAtomic` in `@pi-gui/catalogs`.
pub fn write_file_atomic(path: &Path, data: &[u8]) -> CoreResult<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|error| CoreError::io(&error, dir))?;

    let tmp_path = {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(
            ".{}.{}.{}.tmp",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_add(1),
            unique_suffix()
        ));
        std::path::PathBuf::from(name)
    };

    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(data)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp_path);
        return Err(CoreError::io(&error, &tmp_path));
    }

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(CoreError::io(&error, path));
    }

    // Best effort: some platforms (notably Windows) cannot open a folder to sync it.
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

/// Serializes `value` as two-space JSON with a trailing newline, like `JSON.stringify(v, null, 2)`.
pub fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> CoreResult<()> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| CoreError::new(format!("Could not encode {}: {error}", path.display())))?;
    bytes.push(b'\n');
    write_file_atomic(path, &bytes)
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{:012x}", (nanos as u64) & 0xffff_ffff_ffff)
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
            &serde_json::json!({ "version": 2, "list": [], "map": {}, "n": 3 }),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"version\": 2,\n  \"list\": [],\n  \"map\": {},\n  \"n\": 3\n}\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
