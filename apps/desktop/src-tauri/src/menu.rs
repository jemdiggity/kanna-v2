use tauri::{Emitter, EventTarget, Manager};

pub(crate) const MENU_ID_NEW_WINDOW: &str = "workspace-new-window";
pub(crate) const MENU_ID_CLOSE_WINDOW: &str = "workspace-close-window";
pub(crate) const MENU_ID_NAVIGATE_TASK_UP: &str = "navigate-task-up";
pub(crate) const MENU_ID_NAVIGATE_TASK_DOWN: &str = "navigate-task-down";
pub(crate) const MENU_ID_NAVIGATE_REPO_UP: &str = "navigate-repo-up";
pub(crate) const MENU_ID_NAVIGATE_REPO_DOWN: &str = "navigate-repo-down";
const WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT: &str = "kanna://native-new-window";
const WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT: &str = "kanna://native-close-window";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT: &str = "kanna://native-navigate-task-up";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT: &str = "kanna://native-navigate-task-down";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT: &str = "kanna://native-navigate-repo-up";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT: &str = "kanna://native-navigate-repo-down";

#[derive(Debug, PartialEq, Eq)]
enum NativeWorkspaceMenuAction {
    DispatchToFocused { label: String, event: &'static str },
    CreateRootWindow,
    None,
}

fn resolve_native_workspace_menu_action(
    menu_id: &str,
    focused_label: Option<&str>,
) -> NativeWorkspaceMenuAction {
    match (menu_id, focused_label) {
        (MENU_ID_NEW_WINDOW, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
        },
        (MENU_ID_NEW_WINDOW, None) => NativeWorkspaceMenuAction::CreateRootWindow,
        (MENU_ID_CLOSE_WINDOW, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
        },
        (MENU_ID_NAVIGATE_TASK_UP, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
        },
        (MENU_ID_NAVIGATE_TASK_DOWN, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
        },
        (MENU_ID_NAVIGATE_REPO_UP, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
        },
        (MENU_ID_NAVIGATE_REPO_DOWN, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
        },
        _ => NativeWorkspaceMenuAction::None,
    }
}

fn create_root_kanna_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
        .title("")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()?;
    Ok(())
}

pub(crate) fn handle_native_workspace_menu_event(app: &tauri::AppHandle, menu_id: &str) {
    let focused_label = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label);

    match resolve_native_workspace_menu_action(menu_id, focused_label.as_deref()) {
        NativeWorkspaceMenuAction::DispatchToFocused { label, event } => {
            if app.get_webview_window(&label).is_some() {
                if let Err(error) = app.emit_to(EventTarget::webview_window(&label), event, ()) {
                    eprintln!("[menu] failed to emit {} to {}: {}", event, label, error);
                }
            }
        }
        NativeWorkspaceMenuAction::CreateRootWindow => {
            if let Err(error) = create_root_kanna_window(app) {
                eprintln!("[menu] failed to create root window: {}", error);
            }
        }
        NativeWorkspaceMenuAction::None => {}
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::{
        resolve_native_workspace_menu_action, NativeWorkspaceMenuAction, MENU_ID_CLOSE_WINDOW,
        MENU_ID_NAVIGATE_REPO_DOWN, MENU_ID_NAVIGATE_REPO_UP, MENU_ID_NAVIGATE_TASK_DOWN,
        MENU_ID_NAVIGATE_TASK_UP, MENU_ID_NEW_WINDOW, WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT, WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
    };

    #[test]
    fn native_new_window_dispatches_to_the_focused_window_when_one_exists() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NEW_WINDOW, Some("window-2")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "window-2".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
            }
        );
    }

    #[test]
    fn native_new_window_creates_a_fresh_window_when_none_are_open() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NEW_WINDOW, None),
            NativeWorkspaceMenuAction::CreateRootWindow
        );
    }

    #[test]
    fn native_close_window_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_CLOSE_WINDOW, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
            }
        );
    }

    #[test]
    fn native_task_navigation_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_UP, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
            }
        );
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_DOWN, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
            }
        );
    }

    #[test]
    fn native_task_navigation_is_ignored_without_a_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_DOWN, None),
            NativeWorkspaceMenuAction::None
        );
    }

    #[test]
    fn native_repo_navigation_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_REPO_UP, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
            }
        );
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_REPO_DOWN, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
            }
        );
    }
}
