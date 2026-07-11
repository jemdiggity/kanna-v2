use std::collections::HashSet;
use std::sync::Arc;

use axum::{extract::State, Json};
use kanna_agent_protocol::StateChangeScope;
use serde::{Deserialize, Serialize};

use super::state::AppState;
use crate::db::Db;

const WINDOW_WORKSPACE_SETTINGS_KEY: &str = "window_workspace_v1";
const DEFAULT_SIDEBAR_WIDTH: i64 = 260;
const MIN_SIDEBAR_WIDTH: i64 = 220;
const MAX_SIDEBAR_WIDTH: i64 = 420;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWindowState {
    window_id: String,
    #[serde(default)]
    selected_repo_id: Option<String>,
    #[serde(default)]
    selected_item_id: Option<String>,
    #[serde(default)]
    sidebar_hidden: bool,
    #[serde(default = "default_sidebar_width")]
    sidebar_width: i64,
    #[serde(default)]
    order: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceSnapshot {
    #[serde(default)]
    windows: Vec<WorkspaceWindowState>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceMutationRequest {
    operation: String,
    #[serde(default)]
    window_id: Option<String>,
    #[serde(default)]
    window: Option<WorkspaceWindowState>,
    #[serde(default)]
    selected_repo_id: Option<String>,
    #[serde(default)]
    selected_item_id: Option<String>,
    #[serde(default)]
    sidebar_hidden: Option<bool>,
    #[serde(default)]
    sidebar_width: Option<i64>,
    #[serde(default)]
    observed_window_ids: Option<Vec<String>>,
    #[serde(default)]
    live_window_ids: Option<Vec<String>>,
}

fn default_sidebar_width() -> i64 {
    DEFAULT_SIDEBAR_WIDTH
}

pub(super) async fn mutate_window_workspace(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WorkspaceMutationRequest>,
) -> Result<Json<WorkspaceSnapshot>, (axum::http::StatusCode, String)> {
    validate_mutation(&payload)
        .map_err(|message| (axum::http::StatusCode::BAD_REQUEST, message))?;
    let db = Db::open(&state.config.db_path).map_err(internal_db_error)?;
    let next_json = db
        .mutate_setting(WINDOW_WORKSPACE_SETTINGS_KEY, move |current| {
            let snapshot = current
                .as_deref()
                .and_then(|value| serde_json::from_str::<WorkspaceSnapshot>(value).ok())
                .unwrap_or_default();
            let next = apply_mutation(snapshot, payload);
            serde_json::to_string(&next).map_err(|error| {
                rusqlite::Error::InvalidParameterName(format!(
                    "failed to serialize window workspace: {error}"
                ))
            })
        })
        .map_err(internal_db_error)?;
    let snapshot = serde_json::from_str(&next_json).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("window workspace decode error: {error}"),
        )
    })?;
    state.publish_state_changed(StateChangeScope::Settings);
    Ok(Json(snapshot))
}

fn validate_mutation(payload: &WorkspaceMutationRequest) -> Result<(), String> {
    match payload.operation.as_str() {
        "ensure" if payload.window.is_some() => Ok(()),
        "updateSelection" if payload.window_id.is_some() => Ok(()),
        "updateSidebarHidden"
            if payload.window_id.is_some() && payload.sidebar_hidden.is_some() =>
        {
            Ok(())
        }
        "updateSidebarWidth" if payload.window_id.is_some() && payload.sidebar_width.is_some() => {
            Ok(())
        }
        "remove" if payload.window_id.is_some() => Ok(()),
        operation => Err(format!("invalid window workspace mutation: {operation}")),
    }
}

fn apply_mutation(
    mut snapshot: WorkspaceSnapshot,
    payload: WorkspaceMutationRequest,
) -> WorkspaceSnapshot {
    match payload.operation.as_str() {
        "ensure" => {
            let window = payload.window.expect("validated window");
            if !snapshot
                .windows
                .iter()
                .any(|candidate| candidate.window_id == window.window_id)
            {
                snapshot.windows.push(window);
            }
        }
        "updateSelection" => {
            if let Some(window) = find_window_mut(&mut snapshot, payload.window_id.as_deref()) {
                window.selected_repo_id = payload.selected_repo_id;
                window.selected_item_id = payload.selected_item_id;
            }
        }
        "updateSidebarHidden" => {
            if let Some(window) = find_window_mut(&mut snapshot, payload.window_id.as_deref()) {
                window.sidebar_hidden = payload.sidebar_hidden.expect("validated hidden value");
            }
        }
        "updateSidebarWidth" => {
            if let Some(window) = find_window_mut(&mut snapshot, payload.window_id.as_deref()) {
                window.sidebar_width = payload.sidebar_width.expect("validated width");
            }
        }
        "remove" => {
            let removed_id = payload.window_id.expect("validated window id");
            if let (Some(observed), Some(live)) =
                (payload.observed_window_ids, payload.live_window_ids)
            {
                let observed = observed.into_iter().collect::<HashSet<_>>();
                let live = live.into_iter().collect::<HashSet<_>>();
                snapshot.windows.retain(|window| {
                    !observed.contains(&window.window_id) || live.contains(&window.window_id)
                });
            }
            snapshot
                .windows
                .retain(|window| window.window_id != removed_id);
        }
        _ => unreachable!("validated operation"),
    }
    normalize_snapshot(snapshot)
}

fn find_window_mut<'a>(
    snapshot: &'a mut WorkspaceSnapshot,
    window_id: Option<&str>,
) -> Option<&'a mut WorkspaceWindowState> {
    let window_id = window_id?;
    snapshot
        .windows
        .iter_mut()
        .find(|window| window.window_id == window_id)
}

fn normalize_snapshot(mut snapshot: WorkspaceSnapshot) -> WorkspaceSnapshot {
    snapshot.windows.sort_by_key(|window| window.order);
    let mut seen = HashSet::new();
    snapshot.windows.retain(|window| {
        !window.window_id.trim().is_empty() && seen.insert(window.window_id.clone())
    });
    for (index, window) in snapshot.windows.iter_mut().enumerate() {
        window.order = index as i64;
        if !(MIN_SIDEBAR_WIDTH..=MAX_SIDEBAR_WIDTH).contains(&window.sidebar_width) {
            window.sidebar_width = DEFAULT_SIDEBAR_WIDTH;
        }
    }
    snapshot
}

fn internal_db_error(error: rusqlite::Error) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        format!("db error: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updating_a_missing_window_does_not_recreate_it() {
        let snapshot = WorkspaceSnapshot {
            windows: vec![WorkspaceWindowState {
                window_id: "window-2".to_string(),
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: false,
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                order: 0,
            }],
        };

        let next = apply_mutation(
            snapshot,
            WorkspaceMutationRequest {
                operation: "updateSelection".to_string(),
                window_id: Some("main".to_string()),
                window: None,
                selected_repo_id: Some("repo-stale".to_string()),
                selected_item_id: None,
                sidebar_hidden: None,
                sidebar_width: None,
                observed_window_ids: None,
                live_window_ids: None,
            },
        );

        assert_eq!(next.windows.len(), 1);
        assert_eq!(next.windows[0].window_id, "window-2");
    }

    #[test]
    fn liveness_pruning_preserves_windows_added_after_observation() {
        let window = |window_id: &str, order| WorkspaceWindowState {
            window_id: window_id.to_string(),
            selected_repo_id: None,
            selected_item_id: None,
            sidebar_hidden: false,
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            order,
        };
        let snapshot = WorkspaceSnapshot {
            windows: vec![
                window("main", 0),
                window("window-2", 1),
                window("window-new", 2),
            ],
        };

        let next = apply_mutation(
            snapshot,
            WorkspaceMutationRequest {
                operation: "remove".to_string(),
                window_id: Some("main".to_string()),
                window: None,
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: None,
                sidebar_width: None,
                observed_window_ids: Some(vec!["main".to_string(), "window-2".to_string()]),
                live_window_ids: Some(vec!["main".to_string(), "window-2".to_string()]),
            },
        );

        assert_eq!(
            next.windows
                .iter()
                .map(|window| window.window_id.as_str())
                .collect::<Vec<_>>(),
            vec!["window-2", "window-new"]
        );
    }
}
