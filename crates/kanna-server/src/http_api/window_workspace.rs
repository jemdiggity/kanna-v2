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
const MIN_WINDOW_WIDTH: u32 = 800;
const MIN_WINDOW_HEIGHT: u32 = 600;
const MIN_TEAR_OFF_WINDOW_WIDTH: u32 = 420;
const MIN_TEAR_OFF_WINDOW_HEIGHT: u32 = 280;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl WorkspaceWindowGeometry {
    fn is_usable(&self, tear_off: bool) -> bool {
        let (minimum_width, minimum_height) = if tear_off {
            (MIN_TEAR_OFF_WINDOW_WIDTH, MIN_TEAR_OFF_WINDOW_HEIGHT)
        } else {
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        };
        self.width >= minimum_width && self.height >= minimum_height
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
    #[serde(default)]
    geometry: Option<WorkspaceWindowGeometry>,
    #[serde(default)]
    tear_off_context: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
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
    geometry: Option<WorkspaceWindowGeometry>,
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
        "ensure" | "restore" if payload.window.is_some() => Ok(()),
        "updateSelection" if payload.window_id.is_some() => Ok(()),
        "updateSidebarHidden"
            if payload.window_id.is_some() && payload.sidebar_hidden.is_some() =>
        {
            Ok(())
        }
        "updateSidebarWidth" if payload.window_id.is_some() && payload.sidebar_width.is_some() => {
            Ok(())
        }
        "clearTearOff" if payload.window_id.is_some() => Ok(()),
        "updateGeometry" if payload.window_id.is_some() && payload.geometry.is_some() => Ok(()),
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
        "restore" => {
            let mut window = payload.window.expect("validated window");
            if !snapshot
                .windows
                .iter()
                .any(|candidate| candidate.window_id == window.window_id)
            {
                // A failed closer rejoins behind surviving windows so restoring
                // its old order cannot disturb their stable display order.
                window.order = snapshot
                    .windows
                    .iter()
                    .map(|candidate| candidate.order)
                    .max()
                    .unwrap_or(-1)
                    .saturating_add(1);
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
        "clearTearOff" => {
            if let Some(window) = find_window_mut(&mut snapshot, payload.window_id.as_deref()) {
                window.selected_repo_id = payload.selected_repo_id;
                window.selected_item_id = payload.selected_item_id;
                window.tear_off_context = None;
                window.geometry = None;
            }
        }
        "updateGeometry" => {
            if let Some(window) = find_window_mut(&mut snapshot, payload.window_id.as_deref()) {
                window.geometry = payload.geometry;
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
        if window
            .geometry
            .as_ref()
            .is_some_and(|geometry| !geometry.is_usable(window.tear_off_context.is_some()))
        {
            window.geometry = None;
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
    fn updating_window_geometry_does_not_recreate_missing_windows() {
        let snapshot = WorkspaceSnapshot {
            windows: vec![WorkspaceWindowState {
                window_id: "main".to_string(),
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: false,
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                order: 0,
                geometry: None,
                tear_off_context: None,
            }],
        };
        let geometry = WorkspaceWindowGeometry {
            x: 120,
            y: 90,
            width: 980,
            height: 720,
        };

        let updated = apply_mutation(
            snapshot,
            WorkspaceMutationRequest {
                operation: "updateGeometry".to_string(),
                window_id: Some("main".to_string()),
                window: None,
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: None,
                sidebar_width: None,
                geometry: Some(geometry.clone()),
                observed_window_ids: None,
                live_window_ids: None,
            },
        );
        assert_eq!(updated.windows[0].geometry.as_ref(), Some(&geometry));

        let replayed = apply_mutation(
            updated.clone(),
            WorkspaceMutationRequest {
                operation: "updateGeometry".to_string(),
                window_id: Some("missing".to_string()),
                window: None,
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: None,
                sidebar_width: None,
                geometry: Some(WorkspaceWindowGeometry {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 800,
                }),
                observed_window_ids: None,
                live_window_ids: None,
            },
        );
        assert_eq!(replayed, updated);
    }

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
                geometry: None,
                tear_off_context: None,
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
                geometry: None,
                observed_window_ids: None,
                live_window_ids: None,
            },
        );

        assert_eq!(next.windows.len(), 1);
        assert_eq!(next.windows[0].window_id, "window-2");
    }

    #[test]
    fn restoring_a_window_preserves_its_state_behind_surviving_windows() {
        let snapshot = WorkspaceSnapshot {
            windows: vec![WorkspaceWindowState {
                window_id: "window-2".to_string(),
                selected_repo_id: Some("repo-2".to_string()),
                selected_item_id: Some("task-2".to_string()),
                sidebar_hidden: false,
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                order: 0,
                geometry: None,
                tear_off_context: None,
            }],
        };

        let mutation = WorkspaceMutationRequest {
            operation: "restore".to_string(),
            window_id: None,
            window: Some(WorkspaceWindowState {
                window_id: "main".to_string(),
                selected_repo_id: Some("repo-current".to_string()),
                selected_item_id: Some("task-current".to_string()),
                sidebar_hidden: true,
                sidebar_width: 347,
                order: 0,
                geometry: None,
                tear_off_context: None,
            }),
            selected_repo_id: None,
            selected_item_id: None,
            sidebar_hidden: None,
            sidebar_width: None,
            geometry: None,
            observed_window_ids: None,
            live_window_ids: None,
        };
        let next = apply_mutation(snapshot, mutation);

        assert_eq!(next.windows.len(), 2);
        assert_eq!(next.windows[0].window_id, "window-2");
        assert_eq!(next.windows[0].order, 0);
        assert_eq!(next.windows[1].window_id, "main");
        assert_eq!(
            next.windows[1].selected_repo_id.as_deref(),
            Some("repo-current")
        );
        assert_eq!(
            next.windows[1].selected_item_id.as_deref(),
            Some("task-current")
        );
        assert!(next.windows[1].sidebar_hidden);
        assert_eq!(next.windows[1].sidebar_width, 347);
        assert_eq!(next.windows[1].order, 1);

        let replayed = apply_mutation(
            next.clone(),
            WorkspaceMutationRequest {
                operation: "restore".to_string(),
                window_id: None,
                window: Some(WorkspaceWindowState {
                    window_id: "main".to_string(),
                    selected_repo_id: Some("repo-stale".to_string()),
                    selected_item_id: Some("task-stale".to_string()),
                    sidebar_hidden: false,
                    sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                    order: 0,
                    geometry: None,
                    tear_off_context: None,
                }),
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: None,
                sidebar_width: None,
                geometry: None,
                observed_window_ids: None,
                live_window_ids: None,
            },
        );
        assert_eq!(
            serde_json::to_value(replayed).expect("serialize replayed snapshot"),
            serde_json::to_value(next).expect("serialize original snapshot")
        );
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
            geometry: None,
            tear_off_context: None,
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
                geometry: None,
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

    #[test]
    fn tear_off_windows_keep_modal_sized_geometry() {
        let geometry = WorkspaceWindowGeometry {
            x: 240,
            y: 180,
            width: 780,
            height: 480,
        };
        let snapshot = normalize_snapshot(WorkspaceSnapshot {
            windows: vec![WorkspaceWindowState {
                window_id: "tear-off".to_string(),
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: false,
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                order: 0,
                geometry: Some(geometry.clone()),
                tear_off_context: Some(serde_json::json!({
                    "surface": "tree",
                    "worktreePath": "/repo",
                    "repoRoot": "/repo"
                })),
            }],
        });

        assert_eq!(snapshot.windows[0].geometry.as_ref(), Some(&geometry));
    }

    #[test]
    fn clearing_a_tear_off_keeps_the_window_and_clears_modal_state() {
        let snapshot = WorkspaceSnapshot {
            windows: vec![WorkspaceWindowState {
                window_id: "tear-off".to_string(),
                selected_repo_id: None,
                selected_item_id: None,
                sidebar_hidden: false,
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                order: 0,
                geometry: Some(WorkspaceWindowGeometry {
                    x: 240,
                    y: 180,
                    width: 780,
                    height: 480,
                }),
                tear_off_context: Some(serde_json::json!({
                    "surface": "tree",
                    "worktreePath": "/repo",
                    "repoRoot": "/repo"
                })),
            }],
        };

        let next = apply_mutation(
            snapshot,
            WorkspaceMutationRequest {
                operation: "clearTearOff".to_string(),
                window_id: Some("tear-off".to_string()),
                window: None,
                selected_repo_id: Some("repo-1".to_string()),
                selected_item_id: Some("task-1".to_string()),
                sidebar_hidden: None,
                sidebar_width: None,
                geometry: None,
                observed_window_ids: None,
                live_window_ids: None,
            },
        );

        assert_eq!(next.windows.len(), 1);
        assert_eq!(next.windows[0].selected_repo_id.as_deref(), Some("repo-1"));
        assert_eq!(next.windows[0].selected_item_id.as_deref(), Some("task-1"));
        assert!(next.windows[0].tear_off_context.is_none());
        assert!(next.windows[0].geometry.is_none());
    }
}
