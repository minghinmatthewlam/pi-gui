//! Composer attachments: adding, picking and removing them, and keeping them on disk
//! (loading a thread's saved attachments, checking them at startup, moving legacy inline ones
//! to their own files, and dropping orphans). Saved images over the limits are skipped
//! (`quarantinePersistedComposerAttachments`).

use super::super::dispatch::{self, MethodTable, Reply};
use super::super::shell::PickPaths;
use super::super::validation::{
    self, attachment_limit_error, composer_image_aggregate_limit_message,
    composer_image_bytes_limit_message, decoded_image_byte_length, COMPOSER_IMAGE_MAX_BYTES,
    COMPOSER_IMAGE_MAX_BYTES_TOTAL, COMPOSER_IMAGE_MAX_DIMENSION,
};
use super::super::{persist, publish, sessions, Kernel, WindowId};
use super::{clear_conversation_error, known, publish_composer_attachments};
use crate::error::{CoreError, CoreResult};
use crate::js::JsNumber;
use crate::persistence::catalog::SessionRef;
use crate::state::app_store_utils::clone_composer_attachments;
use crate::state::desktop_state::{ComposerAttachment, DesktopAppState};
use crate::state::driver::session_key;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;

/// `SUPPORTED_COMPOSER_IMAGE_TYPES`.
const SUPPORTED_IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

pub fn register(table: &mut MethodTable) {
    table.on("pickComposerAttachments", |kernel, call| {
        Box::pin(async move {
            catching_limits(&kernel, &call, async {
                let window = dispatch::sender(&kernel, &call)?;
                let target = kernel.windows.target_for_window(&kernel, window);
                let existing = state_for_window(&kernel, window).await.composer_attachments;
                let picked = pick_composer_attachments(&kernel, window, &existing).await?;
                let Some(attachments) = picked.filter(|picked| !picked.is_empty()) else {
                    return Ok(Reply::from(state_for_window(&kernel, window).await));
                };
                assert_pixels(&to_values(&attachments))?;
                dispatch::run_for(&kernel, window, || {
                    add_composer_attachments(&kernel, target.as_ref(), attachments)
                })
                .await
            })
            .await
        })
    });
    table.on("addComposerAttachments", |kernel, call| {
        Box::pin(async move {
            catching_limits(&kernel, &call, async {
                let window = dispatch::sender(&kernel, &call)?;
                let target = kernel.windows.target_for_window(&kernel, window);
                let attachments = validate_payloads(validation::expect_composer_attachments(
                    call.arg(0),
                    "attachments",
                )?);
                assert_pixels(&to_values(&attachments))?;
                dispatch::run_for(&kernel, window, || {
                    add_composer_attachments(&kernel, target.as_ref(), attachments)
                })
                .await
            })
            .await
        })
    });
    table.on("removeComposerAttachment", |kernel, call| {
        Box::pin(async move {
            let window = dispatch::sender(&kernel, &call)?;
            let target = kernel.windows.target_for_window(&kernel, window);
            let attachment_id = call.arg(0).cloned();
            dispatch::run_for(&kernel, window, || async {
                let attachment_id =
                    validation::expect_non_empty_string(attachment_id.as_ref(), "attachmentId")?;
                remove_composer_attachment(&kernel, target.as_ref(), &attachment_id).await
            })
            .await
        })
    });
}

/// `runCatchingLimits`: an image over a limit is shown as the window's error, not thrown.
async fn catching_limits(
    kernel: &Kernel,
    call: &dispatch::InvokeCall,
    action: impl Future<Output = CoreResult<Reply>>,
) -> CoreResult<Reply> {
    match action.await {
        Err(error) if validation::is_attachment_limit_error(&error) => {
            dispatch::run(kernel, call, || sessions::with_core_error(kernel, error)).await
        }
        result => result,
    }
}

/// `stateForWindow`.
async fn state_for_window(kernel: &Kernel, window: WindowId) -> DesktopAppState {
    kernel.initialize().await;
    let view = kernel.windows.view_for_window(kernel, window);
    publish::state_for_view(kernel, &view)
}

fn to_values(attachments: &[ComposerAttachment]) -> Vec<Value> {
    attachments
        .iter()
        .map(|attachment| serde_json::to_value(attachment).unwrap_or(Value::Null))
        .collect()
}

fn attachment_id(attachment: &ComposerAttachment) -> &str {
    match attachment {
        ComposerAttachment::Image { id, .. } | ComposerAttachment::File { id, .. } => id,
    }
}

/// `validateComposerAttachmentPayload`: images of a type pi reads, and files with a path.
fn validate_payloads(attachments: Value) -> Vec<ComposerAttachment> {
    clone_composer_attachments(
        attachments
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .into_iter()
    .filter_map(|attachment| match attachment {
        ComposerAttachment::Image { ref mime_type, .. } => SUPPORTED_IMAGE_TYPES
            .iter()
            .any(|(_, supported)| supported == mime_type)
            .then_some(attachment),
        ComposerAttachment::File {
            id,
            name,
            mime_type,
            fs_path,
            size_bytes,
        } => {
            let fs_path = crate::js::trim(&fs_path).to_owned();
            if fs_path.is_empty() {
                return None;
            }
            let name = match crate::js::trim(&name) {
                "" => file_name(Path::new(&fs_path)),
                trimmed => trimmed.to_owned(),
            };
            Some(ComposerAttachment::File {
                id,
                name,
                mime_type,
                fs_path,
                size_bytes,
            })
        }
    })
    .collect()
}

/// `addComposerAttachments`.
pub async fn add_composer_attachments(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    attachments: Vec<ComposerAttachment>,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref).filter(|_| !attachments.is_empty()) else {
        return Ok(publish::emit(kernel));
    };
    let key = session_key(&session_ref);
    let existing = kernel
        .data
        .borrow()
        .sessions
        .composer_attachments_by_session
        .get(&key)
        .cloned()
        .unwrap_or_default();
    validation::assert_composer_attachments_accepted(
        &to_values(&existing),
        &to_values(&attachments),
    )?;
    let mut next = existing;
    next.extend(attachments);
    {
        let mut data = kernel.data.borrow_mut();
        data.sessions
            .composer_attachments_by_session
            .insert(key.clone(), next.clone());
        clear_conversation_error(&mut data);
        publish_composer_attachments(&mut data, &session_ref, &next);
    }
    persist_composer_attachments(kernel, &key, &next).await?;
    Ok(publish::emit(kernel))
}

/// `removeComposerAttachment`.
pub async fn remove_composer_attachment(
    kernel: &Kernel,
    session_ref: Option<&SessionRef>,
    attachment_id_to_remove: &str,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    let Some(session_ref) = known(kernel, session_ref) else {
        return Ok(publish::emit(kernel));
    };
    let key = session_key(&session_ref);
    let next = {
        let mut data = kernel.data.borrow_mut();
        let mut next = data
            .sessions
            .composer_attachments_by_session
            .get(&key)
            .cloned()
            .unwrap_or_default();
        next.retain(|attachment| attachment_id(attachment) != attachment_id_to_remove);
        super::set_composer_attachments(&mut data, &key, &next);
        publish_composer_attachments(&mut data, &session_ref, &next);
        next
    };
    persist_composer_attachments(kernel, &key, &next).await?;
    Ok(publish::emit(kernel))
}

/// The open dialog's files as attachments (`pickComposerAttachments` in main). Image sizes
/// are checked before any file is read.
async fn pick_composer_attachments(
    kernel: &Kernel,
    window: WindowId,
    existing: &[ComposerAttachment],
) -> CoreResult<Option<Vec<ComposerAttachment>>> {
    let picked = kernel
        .shell()
        .pick_paths(
            Some(window),
            PickPaths {
                title: Some("Attach files".into()),
                directories: false,
                multiple: true,
            },
        )
        .await?;
    let Some(paths) = picked.filter(|paths| !paths.is_empty()) else {
        return Ok(None);
    };
    let mut image_sizes = Vec::new();
    for path in paths.iter().filter(|path| is_image(path)) {
        image_sizes.push(file_size(path).await?);
    }
    assert_image_file_sizes(&image_sizes, existing)?;
    let reads = paths
        .iter()
        .map(|path| read_composer_attachment(kernel, path));
    super::super::futures_join_all(reads)
        .await
        .into_iter()
        .collect::<CoreResult<Vec<_>>>()
        .map(Some)
}

/// `mimeTypeForPath`.
fn mime_type_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    SUPPORTED_IMAGE_TYPES
        .iter()
        .find(|(supported, _)| *supported == extension)
        .map(|(_, mime_type)| *mime_type)
        .unwrap_or("application/octet-stream")
}

fn is_image(path: &Path) -> bool {
    mime_type_for_path(path).starts_with("image/")
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

async fn file_size(path: &Path) -> CoreResult<u64> {
    Ok(tokio::fs::metadata(path)
        .await
        .map_err(|error| CoreError::io(&error, path))?
        .len())
}

/// `assertComposerImageBytes`.
fn assert_image_bytes(bytes: u64) -> CoreResult<()> {
    if bytes > COMPOSER_IMAGE_MAX_BYTES {
        return Err(attachment_limit_error(
            "bytes",
            composer_image_bytes_limit_message(),
        ));
    }
    Ok(())
}

/// `assertComposerImageFileSizes`: each image file, and all of them with the images already
/// attached.
fn assert_image_file_sizes(sizes: &[u64], existing: &[ComposerAttachment]) -> CoreResult<()> {
    let mut incoming = 0;
    for size in sizes {
        assert_image_bytes(*size)?;
        incoming += size;
    }
    let existing_bytes: u64 = existing
        .iter()
        .map(|attachment| match attachment {
            ComposerAttachment::Image { data, .. } => decoded_image_byte_length(data),
            ComposerAttachment::File { .. } => 0,
        })
        .sum();
    if existing_bytes + incoming > COMPOSER_IMAGE_MAX_BYTES_TOTAL {
        return Err(attachment_limit_error(
            "aggregate",
            composer_image_aggregate_limit_message(),
        ));
    }
    Ok(())
}

/// `readComposerAttachment`: an image is read in; any other file is passed by path.
async fn read_composer_attachment(kernel: &Kernel, path: &Path) -> CoreResult<ComposerAttachment> {
    let mime_type = mime_type_for_path(path);
    let size = file_size(path).await?;
    if !mime_type.starts_with("image/") {
        return Ok(ComposerAttachment::File {
            id: kernel.env().random_uuid(),
            name: file_name(path),
            mime_type: mime_type.into(),
            fs_path: path.to_string_lossy().into_owned(),
            size_bytes: Some(JsNumber(size as f64)),
        });
    }
    assert_image_bytes(size)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| CoreError::io(&error, path))?;
    assert_image_bytes(bytes.len() as u64)?;
    if let Some((width, height)) = image_size_of_bytes(&bytes) {
        if width > COMPOSER_IMAGE_MAX_DIMENSION || height > COMPOSER_IMAGE_MAX_DIMENSION {
            return Err(attachment_limit_error(
                "pixels",
                validation::composer_image_pixels_limit_message(),
            ));
        }
    }
    Ok(ComposerAttachment::Image {
        id: kernel.env().random_uuid(),
        name: file_name(path),
        mime_type: mime_type.into(),
        data: encode_base64(&bytes),
    })
}

/// Standard base64 with padding, as `Buffer.toString("base64")`.
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(ALPHABET[(triple >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

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
    image_size_of_bytes(&decode_base64_prefix(base64, 512 * 1024))
}

/// The width and height of a PNG or JPEG file's bytes.
fn image_size_of_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
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
    fn base64_matches_node() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

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
