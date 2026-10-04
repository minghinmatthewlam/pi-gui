//! Path handling with Node's `path` and `fs.realpath` semantics, so checks that used to run in
//! Electron main accept and reject exactly the same paths.

use crate::error::{CoreError, CoreResult};
use std::path::{Component, Path, PathBuf};

/// `path.resolve(base, path)`: absolute, with `.` and `..` folded away lexically.
pub fn resolve(base: &Path, path: impl AsRef<Path>) -> PathBuf {
    let joined = if path.as_ref().is_absolute() {
        path.as_ref().to_path_buf()
    } else {
        let base = if base.is_absolute() {
            base.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(base)
        };
        base.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                resolved.push(component)
            }
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` at the root stays at the root, as in Node.
                if resolved.parent().is_some() {
                    resolved.pop();
                }
            }
        }
    }
    resolved
}

/// `path.resolve(path)` against the process's working folder.
pub fn absolute(path: impl AsRef<Path>) -> PathBuf {
    resolve(&std::env::current_dir().unwrap_or_default(), path)
}

/// `fs.realpath`, without Windows' `\\?\` prefix Node never shows.
pub fn realpath(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// The worktree code's `canonicalPath`: the real path, or the resolved one when it is missing.
pub fn canonical(path: impl AsRef<Path>) -> PathBuf {
    let resolved = absolute(path);
    realpath(&resolved).unwrap_or(resolved)
}

pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `path.relative(root, candidate)` split into names, when `candidate` is `root` or inside it.
/// Both must already be resolved.
pub fn names_below<'a>(root: &Path, candidate: &'a Path) -> Option<Vec<&'a std::ffi::OsStr>> {
    candidate
        .strip_prefix(root)
        .ok()
        .map(|rest| rest.iter().collect())
}

/// `resolveWorkspacePath`: the file's resolved path, refusing anything outside the folder.
pub fn resolve_workspace_path(workspace_path: &str, file_path: &str) -> CoreResult<PathBuf> {
    let workspace_root = absolute(workspace_path);
    let resolved = resolve(&workspace_root, file_path);
    assert_inside_workspace(&workspace_root, &resolved)?;
    Ok(resolved)
}

/// `resolveExistingWorkspacePath`: as above, and the real file may not leave the real folder.
pub async fn resolve_existing_workspace_path(
    workspace_path: &str,
    file_path: &str,
) -> CoreResult<PathBuf> {
    let resolved = resolve_workspace_path(workspace_path, file_path)?;
    let root = absolute(workspace_path);
    let real_root = tokio::fs::canonicalize(&root)
        .await
        .map_err(|error| realpath_error(&error, &root))?;
    let real_target = tokio::fs::canonicalize(&resolved)
        .await
        .map_err(|error| realpath_error(&error, &resolved))?;
    let (real_root, real_target) = (
        dunce::simplified(&real_root),
        dunce::simplified(&real_target),
    );
    assert_inside_workspace(real_root, real_target)?;
    Ok(real_target.to_path_buf())
}

/// Node's message for a failed `fs.realpath`, which the file viewer shows as is.
fn realpath_error(error: &std::io::Error, path: &Path) -> CoreError {
    let mut core_error = CoreError::io(error, path);
    let code = core_error
        .data
        .as_ref()
        .and_then(|data| data.get("code"))
        .and_then(|code| code.as_str())
        .unwrap_or("EIO")
        .to_owned();
    let description = match code.as_str() {
        "ENOENT" => "no such file or directory".to_owned(),
        "EACCES" => "permission denied".to_owned(),
        "ENOTDIR" => "not a directory".to_owned(),
        _ => error.to_string(),
    };
    core_error.message = format!("{code}: {description}, realpath '{}'", path.display());
    core_error
}

/// Same rule as `assertInsideWorkspace`: the relative path may not start with `..`, which
/// also refuses a top-level name such as `..notes`, exactly as before.
fn assert_inside_workspace(root: &Path, candidate: &Path) -> CoreResult<()> {
    match names_below(root, candidate) {
        Some(names)
            if names
                .first()
                .is_none_or(|first| !first.to_string_lossy().starts_with("..")) =>
        {
            Ok(())
        }
        _ => Err(CoreError::new("Path escapes workspace")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        let base = Path::new("/w/root");
        assert_eq!(resolve(base, "a/./b/../c"), PathBuf::from("/w/root/a/c"));
        assert_eq!(resolve(base, "../x"), PathBuf::from("/w/x"));
        assert_eq!(resolve(base, "/abs/../y"), PathBuf::from("/y"));
        assert_eq!(resolve(base, "../../../.."), PathBuf::from("/"));
        assert_eq!(resolve(base, ""), PathBuf::from("/w/root"));
    }

    #[test]
    fn workspace_paths_stay_inside() {
        assert!(resolve_workspace_path("/w", "a/b.txt").is_ok());
        assert!(resolve_workspace_path("/w", ".").is_ok());
        assert!(resolve_workspace_path("/w", "a/../../x").is_err());
        assert!(resolve_workspace_path("/w", "/etc/passwd").is_err());
        assert!(resolve_workspace_path("/w", "..notes").is_err());
        assert!(resolve_workspace_path("/w", "a/..notes").is_ok());
    }
}
