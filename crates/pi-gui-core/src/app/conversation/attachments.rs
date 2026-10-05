//! Composer attachments on disk: loading a thread's saved attachments, checking them at
//! startup, moving legacy inline ones to their own files, and dropping orphans. Saved images
//! over the limits are skipped (`quarantinePersistedComposerAttachments`).

use super::super::validation::{
    decoded_image_byte_length, COMPOSER_IMAGE_MAX_BYTES, COMPOSER_IMAGE_MAX_BYTES_TOTAL,
    COMPOSER_IMAGE_MAX_DIMENSION,
};
use super::super::{persist, Kernel};
use crate::error::CoreResult;
use crate::persistence::catalog::SessionRef;
use crate::state::app_store_utils::clone_composer_attachments;
use crate::state::desktop_state::ComposerAttachment;
use crate::state::driver::session_key;
use serde_json::{json, Value};
use std::collections::HashSet;

/// `composerImageSavedSkipMessage`.
pub fn saved_skip_message(skipped: usize) -> String {
    if skipped == 1 {
        "Skipped an oversized saved image.".into()
    } else {
        format!("Skipped {skipped} oversized saved images.")
    }
}

/// `quarantinePersistedComposerAttachments`: drops images over the byte, total or pixel
/// limits.
pub fn quarantine(attachments: Vec<ComposerAttachment>) -> (Vec<ComposerAttachment>, usize) {
    let mut kept = Vec::new();
    let mut skipped = 0;
    let mut total = 0;
    for attachment in attachments {
        let ComposerAttachment::Image { data, .. } = &attachment else {
            kept.push(attachment);
            continue;
        };
        let bytes = decoded_image_byte_length(data);
        if bytes > COMPOSER_IMAGE_MAX_BYTES || total + bytes > COMPOSER_IMAGE_MAX_BYTES_TOTAL {
            skipped += 1;
            continue;
        }
        total += bytes;
        if image_size(data).is_some_and(|(width, height)| {
            width > COMPOSER_IMAGE_MAX_DIMENSION || height > COMPOSER_IMAGE_MAX_DIMENSION
        }) {
            skipped += 1;
            continue;
        }
        kept.push(attachment);
    }
    (kept, skipped)
}

/// `assertComposerAttachmentPixels`: an image wider or taller than the limit is refused.
pub fn assert_pixels(attachments: &[Value]) -> CoreResult<()> {
    for attachment in attachments {
        if attachment.get("kind").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let data = attachment.get("data").and_then(Value::as_str).unwrap_or("");
        if let Some((width, height)) = image_size(data) {
            if width > COMPOSER_IMAGE_MAX_DIMENSION || height > COMPOSER_IMAGE_MAX_DIMENSION {
                return Err(super::super::validation::attachment_limit_error(
                    "pixels",
                    super::super::validation::composer_image_pixels_limit_message(),
                ));
            }
        }
    }
    Ok(())
}

/// The width and height `nativeImage` reads from a base64 PNG or JPEG; other formats read as
/// empty there, so they are not measured.
pub fn image_size(base64: &str) -> Option<(u32, u32)> {
    let bytes = decode_base64_prefix(base64, 512 * 1024);
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut offset = 2;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if marker == 0xff {
                offset += 1;
                continue;
            }
            if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
                offset += 2;
                continue;
            }
            let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            let is_frame = (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker);
            if is_frame {
                let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
                let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u32;
                return Some((width, height));
            }
            offset += 2 + length;
        }
    }
    None
}

/// Decodes up to `limit` bytes of standard base64, stopping at the first character that is not
/// part of it.
fn decode_base64_prefix(text: &str, limit: usize) -> Vec<u8> {
    fn value(byte: u8) -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    }
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.trim().bytes() {
        if byte == b'=' {
            break;
        }
        let Some(sextet) = value(byte) else {
            if byte.is_ascii_whitespace() {
                continue;
            }
            break;
        };
        buffer = (buffer << 6) | sextet;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            if output.len() >= limit {
                break;
            }
        }
    }
    output
}

async fn read_saved(kernel: &Kernel, key: &str) -> CoreResult<Option<Vec<Value>>> {
    let value = kernel
        .core_call(
            crate::methods::ATTACHMENTS_READ,
            json!({ "sessionKey": key }),
        )
        .await?;
    Ok(match value {
        Value::Array(entries) => Some(entries),
        _ => None,
    })
}

async fn list_keys(kernel: &Kernel) -> CoreResult<Vec<String>> {
    let value = kernel
        .core_call(crate::methods::ATTACHMENTS_LIST_KEYS, Value::Null)
        .await?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

async fn write_saved(
    kernel: &Kernel,
    key: &str,
    attachments: &[ComposerAttachment],
) -> CoreResult<()> {
    kernel
        .core_call(
            crate::methods::ATTACHMENTS_WRITE,
            json!({ "sessionKey": key, "attachments": attachments }),
        )
        .await?;
    Ok(())
}

/// `validatePersistedAttachments`: how many saved images will be skipped.
pub async fn validate_persisted_attachments(kernel: &Kernel) -> CoreResult<usize> {
    let keys = list_keys(kernel).await?;
    let counts = super::super::futures_join_all(keys.iter().map(|key| async move {
        Ok::<_, crate::error::CoreError>(match read_saved(kernel, key).await? {
            Some(saved) => quarantine(clone_composer_attachments(&saved)).1,
            None => 0,
        })
    }))
    .await;
    counts.into_iter().sum()
}

/// `migrateLegacyPersistence`: inline attachments from an older ui-state move to their files.
pub async fn migrate_legacy_attachments(
    kernel: &Kernel,
    persisted: &persist::PersistedUiState,
) -> CoreResult<usize> {
    let entries: Vec<(String, Vec<Value>)> = persisted
        .composer_attachments_by_session
        .iter()
        .flatten()
        .map(|(key, attachments)| (key.clone(), attachments.clone()))
        .collect();
    let counts =
        super::super::futures_join_all(entries.into_iter().map(|(key, attachments)| async move {
            let (kept, skipped) = quarantine(clone_composer_attachments(&attachments));
            if !kept.is_empty() {
                kernel
                    .data
                    .borrow_mut()
                    .sessions
                    .composer_attachments_by_session
                    .insert(key.clone(), kept.clone());
                write_saved(kernel, &key, &kept).await?;
            }
            Ok::<_, crate::error::CoreError>(skipped)
        }))
        .await;
    counts.into_iter().sum()
}

/// `ensureComposerAttachmentsLoaded`.
pub async fn ensure_composer_attachments_loaded(
    kernel: &Kernel,
    session_ref: &SessionRef,
) -> CoreResult<()> {
    let key = session_key(session_ref);
    if kernel
        .data
        .borrow()
        .sessions
        .composer_attachments_by_session
        .contains_key(&key)
    {
        return Ok(());
    }
    let Some(saved) = read_saved(kernel, &key).await? else {
        return Ok(());
    };
    let (kept, _) = quarantine(clone_composer_attachments(&saved));
    kernel
        .data
        .borrow_mut()
        .sessions
        .composer_attachments_by_session
        .insert(key, kept);
    Ok(())
}

/// `pruneOrphanedAttachmentFiles`.
pub async fn prune_orphaned_attachment_files(
    kernel: &Kernel,
    active: &HashSet<String>,
) -> CoreResult<()> {
    let keys = list_keys(kernel).await?;
    let removals = keys.iter().filter(|key| !active.contains(*key)).map(|key| {
        kernel.core_call(
            crate::methods::ATTACHMENTS_REMOVE,
            json!({ "sessionKey": key }),
        )
    });
    for result in super::super::futures_join_all(removals).await {
        result?;
    }
    Ok(())
}

/// `persistComposerAttachments`: the thread's attachments file, then ui-state.
pub async fn persist_composer_attachments(
    kernel: &Kernel,
    key: &str,
    attachments: &[ComposerAttachment],
) -> CoreResult<()> {
    write_saved(kernel, key, attachments).await?;
    persist::persist_ui_state(kernel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn png_sizes_are_read_from_the_header() {
        assert_eq!(image_size(TINY_PNG), Some((1, 1)));
        assert_eq!(image_size("bm90IGFuIGltYWdl"), None);
    }

    #[test]
    fn skip_messages_count_images() {
        assert_eq!(saved_skip_message(1), "Skipped an oversized saved image.");
        assert_eq!(saved_skip_message(3), "Skipped 3 oversized saved images.");
    }
}
