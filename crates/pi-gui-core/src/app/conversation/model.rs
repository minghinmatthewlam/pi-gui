//! The thread's model and thinking level, chosen from the composer's pickers.

use super::submit::{finish_session_change, sync_session_config};
use crate::app::dispatch::{self, MethodTable};
use crate::app::pi::args;
use crate::app::{sessions, validation, Kernel};
use crate::error::CoreResult;
use crate::state::desktop_state::DesktopAppState;
use crate::state::driver::{session_key, session_ref, SessionConfig, SessionRef};
use serde_json::json;

pub fn register(table: &mut MethodTable) {
    table.on("setSessionModel", |kernel, call| {
        Box::pin(async move {
            let call_args = call.args.clone();
            dispatch::run(&kernel, &call, || async {
                let arg = |index: usize| call_args.get(index).and_then(Option::as_ref);
                let target = session_ref(
                    &validation::expect_non_empty_string(arg(0), "workspaceId")?,
                    &validation::expect_non_empty_string(arg(1), "sessionId")?,
                );
                let provider = validation::expect_non_empty_string(arg(2), "provider")?;
                let model_id = validation::expect_non_empty_string(arg(3), "modelId")?;
                set_session_model(&kernel, &target, provider, model_id).await
            })
            .await
        })
    });
    table.on("setSessionThinkingLevel", |kernel, call| {
        Box::pin(async move {
            let call_args = call.args.clone();
            dispatch::run(&kernel, &call, || async {
                let arg = |index: usize| call_args.get(index).and_then(Option::as_ref);
                let target = session_ref(
                    &validation::expect_non_empty_string(arg(0), "workspaceId")?,
                    &validation::expect_non_empty_string(arg(1), "sessionId")?,
                );
                let level = validation::expect_thinking_level(arg(2))?;
                set_session_thinking_level(&kernel, &target, level).await
            })
            .await
        })
    });
}

/// `setSessionModel`.
pub async fn set_session_model(
    kernel: &Kernel,
    session_ref: &SessionRef,
    provider: String,
    model_id: String,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    sessions::with_error_handling(kernel, async {
        kernel
            .driver()
            .call(
                "setSessionModel",
                args([
                    json!(session_ref),
                    json!({ "provider": provider, "modelId": model_id }),
                ]),
            )
            .await?;
        let label = format!("Model set to {provider}:{model_id}");
        sync_session_config(
            &mut kernel.data.borrow_mut(),
            &session_key(session_ref),
            SessionConfig {
                provider: Some(provider),
                model_id: Some(model_id),
                thinking_level: None,
            },
        );
        Ok(finish_session_change(kernel, session_ref, &label, None))
    })
    .await
}

/// `setSessionThinkingLevel`.
pub async fn set_session_thinking_level(
    kernel: &Kernel,
    session_ref: &SessionRef,
    thinking_level: String,
) -> CoreResult<DesktopAppState> {
    kernel.initialize().await;
    sessions::with_error_handling(kernel, async {
        kernel
            .driver()
            .call(
                "setSessionThinkingLevel",
                args([json!(session_ref), json!(thinking_level)]),
            )
            .await?;
        let label = format!("Thinking set to {thinking_level}");
        sync_session_config(
            &mut kernel.data.borrow_mut(),
            &session_key(session_ref),
            SessionConfig {
                thinking_level: Some(thinking_level),
                ..Default::default()
            },
        );
        Ok(finish_session_change(kernel, session_ref, &label, None))
    })
    .await
}
