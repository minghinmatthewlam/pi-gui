//! Slash commands typed in the composer (`contracts/composer-commands.ts`): the app's own
//! commands, and pi's runtime commands (extensions, prompt templates and skills).

use crate::js;
use crate::state::driver::{
    RuntimeCommandRecord, RuntimeCommandSource, RuntimeSnapshot, RuntimeSourceInfo,
    RuntimeSourceOrigin, RuntimeSourceScope, SessionConfig,
};

/// `ParsedComposerCommand`.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedComposerCommand {
    Model { provider: String, model_id: String },
    Thinking { thinking_level: String },
    Tree,
    Status,
    Session,
    Reload,
    Compact { custom_instructions: Option<String> },
    Name { title: String },
}

/// `INCOMPLETE_COMMAND_MESSAGES`.
const INCOMPLETE_COMMAND_MESSAGES: &[(&str, &str)] = &[
    (
        "/compact",
        "Add optional instructions after /compact or send it directly from the slash menu.",
    ),
    (
        "/login",
        "Choose a provider from the slash menu before sending /login.",
    ),
    (
        "/logout",
        "Choose a connected provider from the slash menu before sending /logout.",
    ),
    (
        "/model",
        "Choose a provider and model from the slash menu before sending /model.",
    ),
    ("/name", "Add a thread title after /name."),
    (
        "/scoped-models",
        "Open Enabled models from the slash menu or Settings.",
    ),
    ("/settings", "Open Settings from the slash menu or Cmd+,."),
    (
        "/thinking",
        "Choose a reasoning level from the slash menu before sending /thinking.",
    ),
];

/// `resolveRuntimeCommands`: the thread's commands, plus enabled skills when skill commands
/// are on.
pub fn resolve_runtime_commands(
    runtime: Option<&RuntimeSnapshot>,
    session_commands: &[RuntimeCommandRecord],
) -> Vec<RuntimeCommandRecord> {
    let Some(runtime) = runtime else {
        return session_commands.to_vec();
    };
    if !runtime.settings.enable_skill_commands {
        return session_commands
            .iter()
            .filter(|command| command.source != RuntimeCommandSource::Skill)
            .cloned()
            .collect();
    }
    let mut merged = session_commands.to_vec();
    let mut seen: std::collections::HashSet<String> = session_commands
        .iter()
        .map(|command| command.name.clone())
        .collect();
    for skill in runtime.skills.iter().filter(|skill| skill.enabled) {
        let name = normalize_runtime_command_name(&skill.slash_command);
        if !seen.insert(name.clone()) {
            continue;
        }
        merged.push(RuntimeCommandRecord {
            name,
            description: Some(skill.description.clone()),
            source: RuntimeCommandSource::Skill,
            source_info: RuntimeSourceInfo {
                path: skill.file_path.clone(),
                source: skill.source.clone(),
                scope: if skill.file_path.starts_with(&runtime.workspace.path) {
                    RuntimeSourceScope::Project
                } else {
                    RuntimeSourceScope::User
                },
                origin: RuntimeSourceOrigin::TopLevel,
                base_dir: Some(skill.base_dir.clone()),
            },
        });
    }
    merged
}

/// `resolveRuntimeSlashCommand`.
pub fn resolve_runtime_slash_command(
    text: &str,
    runtime: Option<&RuntimeSnapshot>,
    session_commands: &[RuntimeCommandRecord],
) -> Option<RuntimeCommandRecord> {
    let trimmed = js::trim(text);
    if !trimmed.starts_with('/') {
        return None;
    }
    let name = normalize_runtime_command_name(trimmed.split(' ').next().unwrap_or(trimmed));
    resolve_runtime_commands(runtime, session_commands)
        .into_iter()
        .find(|command| command.name == name)
}

/// `composerSubmitNeedsSenderView`: whether submitting this text can change the sender
/// window's selection, so it must run in that window's queue. Local and extension commands
/// can; skills, prompt templates and other text are prompts that await the whole turn. Until
/// the thread's commands are known, any "/" text may be an extension command.
pub fn composer_submit_needs_sender_view(
    text: &str,
    runtime: Option<&RuntimeSnapshot>,
    session_commands: Option<&[RuntimeCommandRecord]>,
) -> bool {
    let trimmed = js::trim(text);
    if !trimmed.starts_with('/') {
        return false;
    }
    let Some(session_commands) = session_commands else {
        return true;
    };
    if let Some(command) = resolve_runtime_slash_command(trimmed, runtime, session_commands) {
        return command.source == RuntimeCommandSource::Extension;
    }
    parse_composer_command(trimmed).is_some()
        || incomplete_composer_command_message(trimmed).is_some()
}

fn normalize_runtime_command_name(value: &str) -> String {
    js::trim(value).trim_start_matches('/').to_owned()
}

/// `formatSessionConfigStatus`.
pub fn format_session_config_status(config: Option<&SessionConfig>) -> String {
    let mut parts = Vec::new();
    if let Some(config) = config {
        if let (Some(provider), Some(model_id)) = (
            config.provider.as_deref().filter(|value| !value.is_empty()),
            config.model_id.as_deref().filter(|value| !value.is_empty()),
        ) {
            parts.push(format!("Model {provider}:{model_id}"));
        }
        if let Some(level) = config
            .thinking_level
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            parts.push(format!("Thinking {level}"));
        }
    }
    if parts.is_empty() {
        "No session overrides set".into()
    } else {
        parts.join(" · ")
    }
}

/// `trimmed.split(/\s+/)` on text already trimmed.
fn split_words(trimmed: &str) -> Vec<&str> {
    if trimmed.is_empty() {
        return vec![""];
    }
    trimmed
        .split(js::is_space)
        .filter(|word| !word.is_empty())
        .collect()
}

/// `parseComposerCommand`.
pub fn parse_composer_command(value: &str) -> Option<ParsedComposerCommand> {
    let trimmed = js::trim(value);
    match trimmed {
        "/tree" => return Some(ParsedComposerCommand::Tree),
        "/status" => return Some(ParsedComposerCommand::Status),
        "/session" => return Some(ParsedComposerCommand::Session),
        "/reload" => return Some(ParsedComposerCommand::Reload),
        _ => {}
    }
    let words = split_words(trimmed);
    let (command, rest) = (words[0], &words[1..]);
    match command {
        "/compact" => {
            let instructions = rest.join(" ");
            let instructions = js::trim(&instructions);
            Some(ParsedComposerCommand::Compact {
                custom_instructions: (!instructions.is_empty()).then(|| instructions.to_owned()),
            })
        }
        "/name" => {
            let title = rest.join(" ");
            let title = js::trim(&title);
            (!title.is_empty()).then(|| ParsedComposerCommand::Name {
                title: title.to_owned(),
            })
        }
        "/thinking" => {
            let level = js::trim(rest.first()?);
            (!level.is_empty()).then(|| ParsedComposerCommand::Thinking {
                thinking_level: level.to_owned(),
            })
        }
        "/model" => {
            if rest.len() >= 2 {
                return Some(ParsedComposerCommand::Model {
                    provider: rest[0].to_owned(),
                    model_id: rest[1..].join(" "),
                });
            }
            let combined = rest.first()?;
            let (provider, model_id) = combined.split_once(':')?;
            (!provider.is_empty() && !model_id.is_empty()).then(|| ParsedComposerCommand::Model {
                provider: provider.to_owned(),
                model_id: model_id.to_owned(),
            })
        }
        _ => None,
    }
}

/// `incompleteComposerCommandMessage`.
pub fn incomplete_composer_command_message(value: &str) -> Option<&'static str> {
    let trimmed = js::trim(value);
    if !trimmed.starts_with('/') {
        return None;
    }
    let command = split_words(trimmed)[0];
    INCOMPLETE_COMMAND_MESSAGES
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, message)| *message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_like_the_composer() {
        assert_eq!(
            parse_composer_command(" /model openai gpt 5 "),
            Some(ParsedComposerCommand::Model {
                provider: "openai".into(),
                model_id: "gpt 5".into()
            })
        );
        assert_eq!(
            parse_composer_command("/model openai:gpt:5"),
            Some(ParsedComposerCommand::Model {
                provider: "openai".into(),
                model_id: "gpt:5".into()
            })
        );
        assert_eq!(parse_composer_command("/model openai"), None);
        assert_eq!(parse_composer_command("/name   "), None);
        assert_eq!(
            parse_composer_command("/name  My  thread"),
            Some(ParsedComposerCommand::Name {
                title: "My thread".into()
            })
        );
        assert_eq!(
            parse_composer_command("/compact"),
            Some(ParsedComposerCommand::Compact {
                custom_instructions: None
            })
        );
        assert_eq!(
            parse_composer_command("/tree"),
            Some(ParsedComposerCommand::Tree)
        );
        assert_eq!(
            incomplete_composer_command_message("/model"),
            Some("Choose a provider and model from the slash menu before sending /model.")
        );
        assert_eq!(incomplete_composer_command_message("hello"), None);
    }

    #[test]
    fn status_lists_the_overrides() {
        assert_eq!(
            format_session_config_status(None),
            "No session overrides set"
        );
        let config = SessionConfig {
            provider: Some("openai".into()),
            model_id: Some("gpt".into()),
            thinking_level: Some("high".into()),
        };
        assert_eq!(
            format_session_config_status(Some(&config)),
            "Model openai:gpt · Thinking high"
        );
    }

    #[test]
    fn slash_text_waits_for_the_queue_until_commands_are_known() {
        assert!(!composer_submit_needs_sender_view("hello", None, None));
        assert!(composer_submit_needs_sender_view("/anything", None, None));
        assert!(!composer_submit_needs_sender_view(
            "/anything",
            None,
            Some(&[])
        ));
        assert!(composer_submit_needs_sender_view(
            "/status",
            None,
            Some(&[])
        ));
        assert!(composer_submit_needs_sender_view("/model", None, Some(&[])));
    }
}
