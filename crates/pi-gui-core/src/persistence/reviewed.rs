//! `reviewed-files.json`: which review files the user marked as reviewed, as opaque hashes.
//! Same format, limit and messages as the old `ReviewedStore`. Marks are kept oldest first;
//! past the limit the oldest are forgotten.

use super::backup_json::{read_json_with_backup, write_with_backup, FileQueue};
use crate::error::{CoreError, CoreResult};
use crate::js;
use indexmap::IndexSet;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::PathBuf;

/// Enough for one maximal review list (2,000 files) plus recent history.
const DEFAULT_MAX_MARKS: usize = 5_000;

pub struct ReviewedMarks {
    path: PathBuf,
    max_marks: usize,
    /// Read once, then kept in step with every write. A failed read is not kept, so marks
    /// work again without a restart once the file is readable.
    loaded: RefCell<Option<IndexSet<String>>>,
    /// One change at a time, in arrival order.
    turn: tokio::sync::Mutex<()>,
}

impl ReviewedMarks {
    pub fn new(path: PathBuf) -> Self {
        Self::with_limit(path, DEFAULT_MAX_MARKS)
    }

    fn with_limit(path: PathBuf, max_marks: usize) -> Self {
        Self {
            path,
            max_marks,
            loaded: RefCell::new(None),
            turn: tokio::sync::Mutex::default(),
        }
    }

    pub async fn snapshot(&self, queue: &FileQueue) -> CoreResult<Vec<String>> {
        let _turn = self.turn.lock().await;
        Ok(self.load(queue).await?.into_iter().collect())
    }

    pub async fn set(&self, queue: &FileQueue, key: String, reviewed: bool) -> CoreResult<()> {
        let _turn = self.turn.lock().await;
        let previous = self.load(queue).await?;
        if previous.contains(&key) == reviewed {
            return Ok(());
        }
        let mut next = previous;
        if reviewed {
            next.insert(key);
        } else {
            next.shift_remove(&key);
        }
        while next.len() > self.max_marks {
            next.shift_remove_index(0);
        }
        let contents = format!(
            "{}\n",
            js::stringify(&json!({ "version": 1, "marks": next.iter().collect::<Vec<_>>() }))
        );
        // Until the write is done the file may hold either version.
        self.loaded.replace(None);
        let path = self.path.clone();
        queue
            .run(&self.path, move || {
                write_with_backup(&path, &contents, |existing| decode(existing).map(drop))
            })
            .await?;
        self.loaded.replace(Some(next));
        Ok(())
    }

    async fn load(&self, queue: &FileQueue) -> CoreResult<IndexSet<String>> {
        if let Some(marks) = self.loaded.borrow().as_ref() {
            return Ok(marks.clone());
        }
        let path = self.path.clone();
        let marks = queue
            .run(&self.path, move || {
                let result = read_json_with_backup(&path)?;
                if result.corrupted && !result.recovered {
                    return Err(CoreError::new(
                        "Reviewed-file metadata is invalid; the original file was retained.",
                    ));
                }
                result
                    .value
                    .map_or_else(|| Ok(IndexSet::new()), |value| decode(&value))
            })
            .await?;
        self.loaded.replace(Some(marks.clone()));
        Ok(marks)
    }
}

fn decode(value: &Value) -> CoreResult<IndexSet<String>> {
    let is_mark = |mark: &Value| {
        mark.as_str().is_some_and(|mark| {
            mark.len() == 64
                && mark
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    };
    let marks = value.as_object().and_then(|record| {
        let known = record.keys().all(|key| key == "version" || key == "marks");
        let version = record.get("version").and_then(Value::as_f64) == Some(1.0);
        let marks = record.get("marks").and_then(Value::as_array)?;
        (known && version && marks.iter().all(is_mark)).then_some(marks)
    });
    let Some(marks) = marks else {
        return Err(CoreError::new(
            "Reviewed-file metadata is invalid or unsupported; original data retained.",
        ));
    };
    let set: IndexSet<String> = marks
        .iter()
        .filter_map(|mark| mark.as_str().map(str::to_owned))
        .collect();
    if set.len() != marks.len() {
        return Err(CoreError::new("Duplicate reviewed-file mark."));
    }
    Ok(set)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run<T>(work: impl std::future::Future<Output = T>) -> T {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, work)
    }

    #[test]
    fn forgets_the_oldest_marks_past_the_limit_and_skips_unchanged_writes() {
        let dir = crate::test_support::temp_dir("reviewed");
        let path = dir.join("reviewed-files.json");
        let marks: Vec<String> = ["a", "b", "c", "d"].iter().map(|l| l.repeat(64)).collect();
        run(async {
            let queue = FileQueue::default();
            let store = ReviewedMarks::with_limit(path.clone(), 3);
            for mark in &marks {
                store.set(&queue, mark.clone(), true).await.unwrap();
            }
            let reread = ReviewedMarks::new(path.clone());
            assert_eq!(reread.snapshot(&queue).await.unwrap(), marks[1..]);
            let before = fs::read_to_string(&path).unwrap();
            store.set(&queue, marks[1].clone(), true).await.unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), before);
            store.set(&queue, marks[2].clone(), false).await.unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                format!(
                    "{{\"version\":1,\"marks\":[\"{}\",\"{}\"]}}\n",
                    marks[1], marks[3]
                )
            );
        });
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unsupported_files_without_changing_them() {
        let dir = crate::test_support::temp_dir("reviewed-invalid");
        let path = dir.join("reviewed-files.json");
        let original = "{\"version\":99,\"marks\":[],\"future\":\"retain\"}\n";
        fs::write(&path, original).unwrap();
        run(async {
            let queue = FileQueue::default();
            let store = ReviewedMarks::new(path.clone());
            let error = store.snapshot(&queue).await.unwrap_err();
            assert!(error.message.contains("unsupported"));
            assert!(store.set(&queue, "a".repeat(64), true).await.is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
            let duplicate = json!({ "version": 1, "marks": ["a".repeat(64), "a".repeat(64)] });
            assert_eq!(
                decode(&duplicate).unwrap_err().message,
                "Duplicate reviewed-file mark."
            );
        });
        fs::remove_dir_all(dir).unwrap();
    }
}
