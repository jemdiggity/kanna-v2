use crate::db::Db;
use kanna_agent_protocol::CompanionEvent;
use std::path::PathBuf;
use std::sync::Arc;

pub use kanna_visual_companion::CompanionError;

pub struct CompanionScanner {
    scanner: kanna_visual_companion::CompanionScanner,
}

impl Default for CompanionScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl CompanionScanner {
    pub fn new() -> Self {
        Self {
            scanner: kanna_visual_companion::CompanionScanner::new(),
        }
    }

    pub fn with_materialization_budget(
        budget: Arc<kanna_visual_companion::CompanionMaterializationBudget>,
    ) -> Self {
        Self {
            scanner: kanna_visual_companion::CompanionScanner::with_materialization_budget(budget),
        }
    }

    #[allow(dead_code)]
    pub fn scan(
        &mut self,
        db_path: &str,
        task_id: &str,
    ) -> Result<kanna_visual_companion::CompanionScan, CompanionError> {
        self.scan_with_assets(db_path, task_id, true)
    }

    pub fn scan_with_assets(
        &mut self,
        db_path: &str,
        task_id: &str,
        include_assets: bool,
    ) -> Result<kanna_visual_companion::CompanionScan, CompanionError> {
        let workspace = match current_workspace(db_path, task_id) {
            Ok(workspace) => workspace,
            Err(error) => {
                self.scanner.invalidate();
                return Err(error);
            }
        };
        self.scanner.scan_with_assets(&workspace, include_assets)
    }

    pub fn invalidate(&mut self) {
        self.scanner.invalidate();
    }
}

#[cfg(test)]
pub fn current_bundle(
    db_path: &str,
    task_id: &str,
) -> Result<Option<kanna_visual_companion::CompanionBundle>, CompanionError> {
    let workspace = current_workspace(db_path, task_id)?;
    kanna_visual_companion::current_bundle(&workspace)
}

pub fn append_event(
    db_path: &str,
    task_id: &str,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<(), CompanionError> {
    kanna_visual_companion::append_event_with_workspace_resolver(
        || current_workspace(db_path, task_id),
        session_id,
        revision,
        event,
    )
}

fn current_workspace(db_path: &str, task_or_branch_id: &str) -> Result<PathBuf, CompanionError> {
    let db = Db::open(db_path)
        .map_err(|_| CompanionError::Internal("failed to open Kanna database".into()))?;
    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|_| CompanionError::Internal("failed to resolve companion task".into()))?
        .ok_or(CompanionError::TaskNotFound)?;
    db.get_task_worktree_path(&task_id)
        .map_err(|_| CompanionError::Internal("failed to resolve task workspace".into()))?
        .map(PathBuf::from)
        .ok_or(CompanionError::WorkspaceUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::path::{Path, PathBuf};

    struct Fixture {
        db: Db,
        db_path: PathBuf,
        worktree: PathBuf,
        temp_dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let temp_dir = tempfile::tempdir().expect("create companion fixture");
            let worktree = temp_dir.path().join("worktree");
            std::fs::create_dir_all(&worktree).expect("create fixture worktree");
            let db_path = temp_dir.path().join("kanna.sqlite");
            let db = Db::open_for_tests(db_path.to_str().expect("utf-8 database path"))
                .expect("open fixture database");
            db.insert_test_repo_with_path(
                "repo-1",
                temp_dir.path().to_str().expect("utf-8 repository path"),
                "Repo One",
            )
            .expect("insert fixture repository");
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Show a visual companion",
                Some("Show a visual companion"),
                "in progress",
                "2026-07-17 10:00:00",
            )
            .expect("insert fixture task");
            db.upsert_worktree(
                "wt-task-1",
                "task-1",
                worktree.to_str().expect("utf-8 worktree path"),
                "branch-task-1",
            )
            .expect("insert fixture worktree");
            Self {
                db,
                db_path,
                worktree,
                temp_dir,
            }
        }

        fn db_path(&self) -> &str {
            self.db_path.to_str().expect("utf-8 database path")
        }

        fn active_session(&self, session_id: &str, file_name: &str, html: &str) {
            let session = self
                .worktree
                .join(".superpowers/brainstorm")
                .join(session_id);
            std::fs::create_dir_all(session.join("state")).unwrap();
            std::fs::create_dir_all(session.join("content")).unwrap();
            std::fs::write(session.join("state/server-info"), "{}").unwrap();
            std::fs::write(session.join("content").join(file_name), html).unwrap();
        }
    }

    #[test]
    fn resolves_the_current_workspace_for_a_task() {
        let fixture = Fixture::new();
        fixture.active_session("session-a", "screen.html", "<h2>A</h2>");

        let document = current_bundle(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();

        assert_eq!(document.session_id, "session-a");
        assert_eq!(document.html, "<h2>A</h2>");
    }

    #[test]
    fn server_scan_prepares_sibling_images_for_assetless_clients() {
        let fixture = Fixture::new();
        fixture.active_session(
            "session-a",
            "screen.html",
            r#"<figure><img src="01.png"></figure>"#,
        );
        std::fs::write(
            fixture
                .worktree
                .join(".superpowers/brainstorm/session-a/content/01.png"),
            b"PNG",
        )
        .unwrap();
        let mut scanner = CompanionScanner::new();

        let kanna_visual_companion::CompanionScan::Changed(Some(bundle)) = scanner
            .scan_with_assets(fixture.db_path(), "task-1", false)
            .unwrap()
        else {
            panic!("expected prepared companion snapshot");
        };

        assert_eq!(
            bundle.html,
            r#"<figure><img src="data:image/png;base64,UE5H"></figure>"#
        );
        assert!(bundle.assets.is_empty());
    }

    #[test]
    fn reports_tasks_without_a_current_workspace() {
        let fixture = Fixture::new();
        fixture
            .db
            .insert_test_pipeline_item(
                "task-2",
                "repo-1",
                "No workspace",
                None,
                "in progress",
                "2026-07-17 10:00:00",
            )
            .unwrap();
        assert_eq!(
            current_bundle(fixture.db_path(), "task-2"),
            Err(CompanionError::WorkspaceUnavailable)
        );
        assert_eq!(
            current_bundle(fixture.db_path(), "missing-task"),
            Err(CompanionError::TaskNotFound)
        );
    }

    #[test]
    fn rejects_invalid_events_before_resolving_the_task_workspace() {
        let fixture = Fixture::new();
        fixture
            .db
            .insert_test_pipeline_item(
                "task-2",
                "repo-1",
                "No workspace",
                None,
                "in progress",
                "2026-07-17 10:00:00",
            )
            .unwrap();
        let invalid_event = CompanionEvent {
            session_id: "session-a".into(),
            revision: "revision-a".into(),
            event_id: "event-1".into(),
            event_type: "submit".into(),
            choice: "a".into(),
            text: "Option A".into(),
            element_id: None,
            timestamp: 1_784_268_000_000,
        };

        assert_eq!(
            append_event(
                fixture.db_path(),
                "missing-task",
                "session-a",
                "revision-a",
                &invalid_event,
            ),
            Err(CompanionError::InvalidEvent)
        );
        assert_eq!(
            append_event(
                fixture.db_path(),
                "task-2",
                "session-a",
                "revision-a",
                &invalid_event,
            ),
            Err(CompanionError::InvalidEvent)
        );
    }

    #[test]
    fn rejects_a_database_workspace_mapping_replaced_during_event_validation() {
        let fixture = Fixture::new();
        fixture.active_session("session-a", "screen.html", "screen");
        let document = current_bundle(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let old_events = fixture
            .worktree
            .join(".superpowers/brainstorm/session-a/state/events");
        let replacement = fixture.temp_dir.path().join("replacement");
        std::fs::create_dir_all(&replacement).unwrap();
        let replacement_events = replacement.join(".superpowers/brainstorm/session-a/state/events");
        let event = CompanionEvent {
            session_id: document.session_id.clone(),
            revision: document.revision.clone(),
            event_id: "event-1".into(),
            event_type: "click".into(),
            choice: "a".into(),
            text: "Option A".into(),
            element_id: None,
            timestamp: 1_784_268_000_000,
        };
        let mut resolution_count = 0;

        let result = kanna_visual_companion::append_event_with_workspace_resolver(
            || {
                resolution_count += 1;
                if resolution_count == 2 {
                    fixture
                        .db
                        .upsert_worktree(
                            "wt-task-1",
                            "task-1",
                            replacement.to_str().unwrap(),
                            "replacement-branch",
                        )
                        .unwrap();
                }
                current_workspace(fixture.db_path(), "task-1")
            },
            &document.session_id,
            &document.revision,
            &event,
        );

        assert_eq!(resolution_count, 2);
        assert_eq!(result, Err(CompanionError::StaleRevision));
        assert!(!old_events.exists());
        assert!(!replacement_events.exists());
    }

    #[test]
    fn follows_the_database_workspace_replacement_not_the_old_path() {
        let fixture = Fixture::new();
        fixture.active_session("old", "layout.html", "old companion");
        let replacement = fixture.temp_dir.path().join("replacement");
        std::fs::create_dir_all(&replacement).unwrap();
        fixture
            .db
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                replacement.to_str().unwrap(),
                "replacement-branch",
            )
            .unwrap();

        assert_eq!(current_bundle(fixture.db_path(), "task-1").unwrap(), None);
    }

    #[test]
    fn scanner_resolves_the_authoritative_workspace_on_every_poll() {
        let fixture = Fixture::new();
        fixture.active_session("old", "layout.html", "old companion");
        let mut scanner = CompanionScanner::new();
        assert!(matches!(
            scanner.scan(fixture.db_path(), "task-1").unwrap(),
            kanna_visual_companion::CompanionScan::Changed(Some(_))
        ));

        let replacement = fixture.temp_dir.path().join("scanner-replacement");
        let session = replacement.join(".superpowers/brainstorm/new");
        std::fs::create_dir_all(session.join("state")).unwrap();
        std::fs::create_dir_all(session.join("content")).unwrap();
        std::fs::write(session.join("state/server-info"), "{}").unwrap();
        std::fs::write(session.join("content/layout.html"), "new companion").unwrap();
        fixture
            .db
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                replacement.to_str().unwrap(),
                "scanner-replacement-branch",
            )
            .unwrap();

        let kanna_visual_companion::CompanionScan::Changed(Some(bundle)) =
            scanner.scan(fixture.db_path(), "task-1").unwrap()
        else {
            panic!("workspace mapping change was not detected");
        };
        assert_eq!(bundle.session_id, "new");
    }

    #[test]
    fn rejects_a_relative_database_workspace_path() {
        let fixture = Fixture::new();
        fixture
            .db
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                Path::new("relative").to_str().unwrap(),
                "branch",
            )
            .unwrap();

        assert_eq!(
            current_bundle(fixture.db_path(), "task-1"),
            Err(CompanionError::WorkspaceUnavailable)
        );
    }
}
