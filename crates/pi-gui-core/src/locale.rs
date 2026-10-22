//! JavaScript's `localeCompare`, for orderings that must match what the app showed before.

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use std::cmp::Ordering;
use std::sync::OnceLock;

/// `left.localeCompare(right)`: the same ICU root collation V8 uses.
pub fn compare(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), CollatorOptions::default())
                .expect("the root collation is compiled in")
        })
        .compare(left, right)
}
