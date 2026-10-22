//! Provider sign-in: the callbacks pi calls back into the app for while it signs in
//! (`createRuntimeLoginCallbacks` in `electron/main.ts`), and the text prompt they show.

use super::super::pi::LoginCallbacks;
use super::super::shell::PromptText;
use super::super::{Kernel, WindowId};
use crate::error::{CoreError, CoreResult};
use crate::rpc::LocalFuture;
use serde_json::{json, Value};
use std::rc::Rc;

/// `promptForText`: the shell's text prompt, trimmed. Cancelling it, or leaving it empty
/// when an answer is needed, fails the sign-in.
pub async fn prompt_for_text(
    kernel: &Kernel,
    parent: Option<WindowId>,
    message: String,
    placeholder: String,
    allow_empty: bool,
) -> CoreResult<String> {
    let answer = kernel
        .shell()
        .prompt_text(
            parent,
            PromptText {
                message,
                placeholder,
                allow_empty,
            },
        )
        .await?;
    let Some(answer) = answer else {
        return Err(CoreError::new("Login cancelled."));
    };
    let trimmed = crate::js::trim(&answer);
    if !allow_empty && trimmed.is_empty() {
        return Err(CoreError::new("Login cancelled."));
    }
    Ok(trimmed.to_owned())
}

/// The sign-in callbacks for one window's login.
pub struct WindowLoginCallbacks {
    pub kernel: Rc<Kernel>,
    pub window: Option<WindowId>,
}

impl LoginCallbacks for WindowLoginCallbacks {
    /// Opens the provider's page, then shows its instructions, if any.
    fn on_auth(&self, info: Value) -> LocalFuture<CoreResult<()>> {
        let kernel = self.kernel.clone();
        let window = self.window;
        Box::pin(async move {
            let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
            kernel.shell().open_external(url.to_owned()).await?;
            let instructions = info
                .get("instructions")
                .and_then(Value::as_str)
                .map(crate::js::trim)
                .unwrap_or_default();
            if !instructions.is_empty() {
                kernel
                    .shell()
                    .show_message(window, instructions.to_owned())
                    .await?;
            }
            Ok(())
        })
    }

    fn on_prompt(&self, prompt: Value) -> LocalFuture<CoreResult<Value>> {
        let kernel = self.kernel.clone();
        let window = self.window;
        Box::pin(async move {
            let text = |key: &str| {
                prompt
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            let allow_empty = prompt
                .get("allowEmpty")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let answer = prompt_for_text(
                &kernel,
                window,
                text("message"),
                text("placeholder"),
                allow_empty,
            )
            .await?;
            Ok(json!(answer))
        })
    }

    fn on_progress(&self, _message: String) -> Option<LocalFuture<CoreResult<()>>> {
        None
    }

    fn on_manual_code(&self) -> Option<LocalFuture<CoreResult<Value>>> {
        None
    }

    fn has_progress(&self) -> bool {
        false
    }

    fn has_manual_code_input(&self) -> bool {
        false
    }
}
