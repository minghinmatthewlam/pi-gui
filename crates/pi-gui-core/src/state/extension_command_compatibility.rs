//! Twin of `apps/desktop/electron/conversation/extension-command-compatibility.ts`: which
//! extension commands the app learned only work in terminal pi.

use indexmap::IndexMap;

use super::desktop_state::ExtensionCommandCompatibilityRecord;
use super::driver::{RuntimeCommandRecord, RuntimeSnapshot};
use crate::locale::compare as compare_display_names;

/// Records by workspace id, then by `createCompatibilityKey`.
pub type CompatibilityByWorkspace =
    IndexMap<String, IndexMap<String, ExtensionCommandCompatibilityRecord>>;

/// `PendingRuntimeCommandExecution`.
#[derive(Debug, Clone)]
pub struct PendingRuntimeCommandExecution {
    pub command: RuntimeCommandRecord,
    pub blocked_message: Option<String>,
}

/// `createCompatibilityKey`.
pub fn create_compatibility_key(extension_path: &str, command_name: &str) -> String {
    format!("{extension_path}::{command_name}")
}

/// `createCompatibilityKeyForCommand`.
pub fn create_compatibility_key_for_command(command: &RuntimeCommandRecord) -> String {
    create_compatibility_key(&command.source_info.path, &command.name)
}

/// `getLearnedCommandCompatibility`.
pub fn get_learned_command_compatibility<'a>(
    compatibility_by_workspace: &'a CompatibilityByWorkspace,
    workspace_id: &str,
    command: &RuntimeCommandRecord,
) -> Option<&'a ExtensionCommandCompatibilityRecord> {
    compatibility_by_workspace
        .get(workspace_id)?
        .get(&create_compatibility_key_for_command(command))
}

/// `recordLearnedCommandCompatibility`.
pub fn record_learned_command_compatibility(
    compatibility_by_workspace: &mut CompatibilityByWorkspace,
    workspace_id: &str,
    record: ExtensionCommandCompatibilityRecord,
) -> ExtensionCommandCompatibilityRecord {
    compatibility_by_workspace
        .entry(workspace_id.to_string())
        .or_default()
        .insert(
            create_compatibility_key(&record.extension_path, &record.command_name),
            record.clone(),
        );
    record
}

/// `serializeCompatibilityByWorkspace`: each workspace's records sorted by extension path,
/// then command name.
pub fn serialize_compatibility_by_workspace(
    compatibility_by_workspace: &CompatibilityByWorkspace,
) -> IndexMap<String, Vec<ExtensionCommandCompatibilityRecord>> {
    compatibility_by_workspace
        .iter()
        .map(|(workspace_id, records)| {
            let mut records: Vec<_> = records.values().cloned().collect();
            records.sort_by(|left, right| {
                compare_display_names(&left.extension_path, &right.extension_path)
                    .then_with(|| compare_display_names(&left.command_name, &right.command_name))
            });
            (workspace_id.clone(), records)
        })
        .collect()
}

/// `restoreCompatibilityByWorkspace`: saved records, without ones missing a name or path.
pub fn restore_compatibility_by_workspace(
    payload: Option<&IndexMap<String, Vec<ExtensionCommandCompatibilityRecord>>>,
) -> CompatibilityByWorkspace {
    let mut restored = CompatibilityByWorkspace::new();
    for (workspace_id, records) in payload.into_iter().flatten() {
        let mut by_workspace = IndexMap::new();
        for record in records {
            if record.command_name.is_empty() || record.extension_path.is_empty() {
                continue;
            }
            by_workspace.insert(
                create_compatibility_key(&record.extension_path, &record.command_name),
                record.clone(),
            );
        }
        if !by_workspace.is_empty() {
            restored.insert(workspace_id.clone(), by_workspace);
        }
    }
    restored
}

/// `pruneCompatibilityForRuntimeSnapshot`: forgets records whose extension or command is gone.
pub fn prune_compatibility_for_runtime_snapshot(
    compatibility_by_workspace: &mut CompatibilityByWorkspace,
    runtime: Option<&RuntimeSnapshot>,
) {
    let Some(runtime) = runtime else {
        return;
    };
    let workspace_id = &runtime.workspace.workspace_id;
    let Some(by_workspace) = compatibility_by_workspace.get_mut(workspace_id) else {
        return;
    };
    // Later extensions with the same path win, as when a JavaScript Map is built from a list.
    let mut live_extensions = IndexMap::new();
    for extension in &runtime.extensions {
        live_extensions.insert(extension.path.as_str(), extension);
    }
    by_workspace.retain(|_, record| {
        let Some(extension) = live_extensions.get(record.extension_path.as_str()) else {
            return false;
        };
        let base_command_name = record
            .command_name
            .split(':')
            .next()
            .unwrap_or(&record.command_name);
        extension
            .commands
            .iter()
            .any(|command| command == base_command_name)
    });
    if by_workspace.is_empty() {
        compatibility_by_workspace.shift_remove(workspace_id);
    }
}
