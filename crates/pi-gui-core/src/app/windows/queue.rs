//! `SerializedActionQueue`: state actions from every window run one at a time, in the order
//! they arrived. A failed action does not stop the ones behind it.

use std::future::Future;

#[derive(Default)]
pub struct ActionQueue {
    /// Tokio's mutex hands the lock out first come, first served.
    lock: tokio::sync::Mutex<()>,
}

impl ActionQueue {
    /// Runs `action` once every action queued before it has finished.
    pub async fn run<T>(&self, action: impl Future<Output = T>) -> T {
        let _turn = self.lock.lock().await;
        action.await
    }

    /// True while an action runs.
    pub fn is_busy(&self) -> bool {
        self.lock.try_lock().is_err()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn actions_run_one_at_a_time_in_arrival_order() {
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let queue = Rc::new(ActionQueue::default());
                let log = Rc::new(RefCell::new(Vec::new()));
                let mut tasks = Vec::new();
                for (index, delay) in [(0, 30u64), (1, 0), (2, 10)] {
                    let queue = queue.clone();
                    let log = log.clone();
                    tasks.push(tokio::task::spawn_local(async move {
                        queue
                            .run(async {
                                log.borrow_mut().push(format!("start {index}"));
                                tokio::time::sleep(Duration::from_millis(delay)).await;
                                log.borrow_mut().push(format!("end {index}"));
                                if index == 1 {
                                    Err("failed")
                                } else {
                                    Ok(index)
                                }
                            })
                            .await
                    }));
                    tokio::task::yield_now().await;
                }
                let mut results = Vec::new();
                for task in tasks {
                    results.push(task.await.unwrap());
                }
                assert_eq!(results, vec![Ok(0), Err("failed"), Ok(2)]);
                assert_eq!(
                    *log.borrow(),
                    ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]
                );
                assert!(!queue.is_busy());
            })
            .await;
    }
}
