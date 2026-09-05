//! Workspace forks must cut from the task's latest committed tip.
//!
//! Reproduces the shape observed on task `7a38cc18` (2026-08-21): a revision
//! resumes the implement run — which rewinds `pipeline_item.branch` to that
//! run's older workspace — while the round's commit lands in the reviewer's
//! fork. Forking the next review workspace from the rewound branch dropped the
//! round's commit, so the next reviewer re-raised the identical finding. The
//! regression is covered by the tests below.

use super::revision::{write_resume_transcript, RESUME_SESSION_UUID};
use super::*;
use crate::task_creator::types::PreparedStageRunSpawn;
use crate::task_creator::work_tip::{
    reconcile_task_work_branch, resolve_task_work_tip, task_workspaces, WorkTipResolution,
};

const TASK_ID: &str = "wt1";

fn run_git_in(worktree: &std::path::Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        worktree.display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn commit_in(worktree: &std::path::Path, file: &str, message: &str) -> String {
    std::fs::write(worktree.join(file), message).unwrap();
    run_git_in(worktree, &["add", file]);
    run_git_in(worktree, &["commit", "-m", message]);
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(worktree)
            .output()
            .expect("rev-parse")
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string()
}

fn branch_contains(repo_root: &std::path::Path, branch: &str, commit: &str) -> bool {
    Command::new("git")
        .args(["merge-base", "--is-ancestor", commit, branch])
        .current_dir(repo_root)
        .status()
        .expect("merge-base")
        .success()
}

fn task_branch(db: &Db) -> String {
    db.get_task_stage_source(TASK_ID)
        .unwrap()
        .unwrap()
        .branch
        .expect("task has a branch")
}

/// Repo with a `single-reviewer`-shaped workflow, a task parked at
/// `in progress` on its creation workspace with one implementation commit, and
/// the implement + commit-post runs the engine would have recorded there.
fn init_fixture(label: &str, config: &Config) -> (std::path::PathBuf, Db) {
    let repo_root = init_git_repo(label);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    for agent in ["implement", "commit", "review"] {
        std::fs::create_dir_all(repo_root.join(".kanna/agents").join(agent)).unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents").join(agent).join("AGENT.md"),
            format!(
                "---\nname: {agent}\ndescription: Test {agent} agent\nagent_provider: claude\n---\n{agent}: $TASK_PROMPT",
            ),
        )
        .unwrap();
    }
    std::fs::write(
        repo_root.join(".kanna/workflows/qa.json"),
        r#"{
  "stages": [
    {
      "name": "in progress",
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "policy": { "transition": "manual", "revision_transition": "auto" },
      "post": { "name": "commit", "agent": "commit", "prompt": "Commit the work for $TASK_PROMPT" }
    },
    { "name": "review", "agent": "review", "prompt": "Review $BRANCH", "policy": { "transition": "manual" } }
  ]
}"#,
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish work-tip workflow definitions");

    let creation_branch = format!("task-{TASK_ID}");
    run_git_fixture(&repo_root, &["branch", &creation_branch]);
    let creation_worktree = repo_root.join(".kanna-worktrees").join(&creation_branch);
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            creation_worktree.to_string_lossy().as_ref(),
            &creation_branch,
        ],
    );
    commit_in(&creation_worktree, "impl.txt", "implementation");

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        TASK_ID,
        "repo-1",
        "Original implementation prompt",
        Some("Work tip task"),
        "in progress",
        "2026-08-20 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(TASK_ID, &creation_branch, "qa", None, "claude")
        .unwrap();
    db.upsert_worktree(
        &format!("wt-{TASK_ID}"),
        TASK_ID,
        &creation_worktree.to_string_lossy(),
        &creation_branch,
    )
    .unwrap();
    record_finished_run(
        &db,
        "run-impl",
        "in progress",
        "main",
        "implement",
        &creation_worktree,
    );
    record_finished_run(
        &db,
        "run-commit-1",
        "commit",
        "post",
        "commit",
        &creation_worktree,
    );
    (repo_root, db)
}

/// A stage run recorded exactly as the engine records one: the worktree it was
/// prepared for, and the implement session's provider transcript id (which is
/// what a later revision resumes).
fn record_finished_run(
    db: &Db,
    id: &str,
    stage: &str,
    kind: &str,
    agent: &str,
    cwd: &std::path::Path,
) {
    db.insert_stage_run(NewStageRun {
        id,
        task_id: TASK_ID,
        stage,
        kind,
        agent: Some(agent),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some(TASK_ID),
        provider_session_id: Some(RESUME_SESSION_UUID),
        cwd: Some(cwd.to_string_lossy().as_ref()),
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run(id, "succeeded", Some("{\"status\":\"success\"}"), None)
        .unwrap();
}

fn fail_latest_run(db: &Db, feedback: &str) {
    let runs = db.list_stage_runs_for_task(TASK_ID).unwrap();
    let latest = runs.last().expect("a run to fail");
    db.finish_stage_run(
        &latest.id,
        "failed",
        Some("{\"status\":\"failure\",\"summary\":\"changes requested\"}"),
        Some(feedback),
    )
    .unwrap();
}

/// The post-completion transition: the same call the engine makes when a
/// `commit` post records success.
fn prepare_review_fork(db: &Db, config: &Config) -> Box<PreparedStageRunSpawn> {
    match prepare_stage_completion_for_api(db, config, TASK_ID, Some("post"), None)
        .unwrap()
        .expect("post completion swaps to the next stage")
    {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => {
            panic!("expected a forked stage run, got post dispatch")
        }
        PreparedStageTransition::Close { .. } => {
            panic!("expected a forked stage run, got task close")
        }
    }
}

fn prepare_resumed_revision(
    db: &Db,
    config: &Config,
    claude_config_dir: &std::path::Path,
    feedback: &str,
) -> PreparedStageRunSpawn {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", claude_config_dir);
    let prepared =
        prepare_revision_task_for_api(db, config, TASK_ID, "in progress", feedback, None);
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    prepared.unwrap()
}

/// Two full revision rounds. Each round's commit lands in the reviewer's
/// workspace rather than the one `pipeline_item.branch` names, and every
/// review fork must still carry every landed commit.
#[tokio::test]
async fn each_review_fork_carries_every_previous_revision_round_commit() {
    let config = test_config("work-tip-revision-rounds");
    let (repo_root, db) = init_fixture("work-tip-revision-rounds", &config);
    let creation_worktree = repo_root.join(format!(".kanna-worktrees/task-{TASK_ID}"));
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &creation_worktree);

    // 5 spawns: review fork, revision, review fork, revision, review fork.
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 5).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let replacements = crate::session_replacements::SessionReplacements::default();

    // --- The first review fork, from the implementation's committed tip.
    let first_review = prepare_review_fork(&db, &config);
    let first_review_branch = first_review
        .forked_workspace()
        .expect("review forks a workspace")
        .branch
        .clone();
    assert_eq!(first_review_branch, format!("task-{TASK_ID}-2"));
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *first_review)
        .await
        .unwrap();
    assert_eq!(task_branch(&db), first_review_branch);

    // --- Round 1: review fails, the revision resumes the implement session.
    fail_latest_run(&db, "Round 1: add the missing coverage.");
    let revision = prepare_resumed_revision(
        &db,
        &config,
        &claude_config_dir,
        "Round 1: add the missing coverage.",
    );
    assert_eq!(
        revision
            .resumed_workspace()
            .expect("the revision resumes the implement workspace")
            .branch,
        format!("task-{TASK_ID}"),
    );
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, revision)
        .await
        .unwrap();
    // The resume rewinds the task's branch to the implement workspace...
    assert_eq!(task_branch(&db), format!("task-{TASK_ID}"));

    // ...while the round's commit lands in the reviewer's workspace, which is
    // where the observed agent worked.
    let round_one = commit_in(
        &repo_root.join(format!(".kanna-worktrees/{first_review_branch}")),
        "round-one.txt",
        "round one fix",
    );
    record_finished_run(
        &db,
        "run-commit-2",
        "commit",
        "post",
        "commit",
        &creation_worktree,
    );

    // --- The second review fork must carry round 1's commit.
    let second_review = prepare_review_fork(&db, &config);
    let second_review_workspace = second_review
        .forked_workspace()
        .expect("review forks a workspace");
    assert!(
        branch_contains(&repo_root, &second_review_workspace.branch, &round_one),
        "the second review fork must contain round 1's commit {round_one}",
    );
    assert!(std::path::Path::new(&second_review_workspace.worktree_path)
        .join("round-one.txt")
        .is_file());
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *second_review)
        .await
        .unwrap();

    // --- Round 2, on top of round 1.
    fail_latest_run(&db, "Round 2: the coverage still misses a case.");
    let revision = prepare_resumed_revision(
        &db,
        &config,
        &claude_config_dir,
        "Round 2: the coverage still misses a case.",
    );
    // The implement workspace no longer holds the tip, so the resume
    // precondition fails and the revision forks fresh — from the tip.
    let revision_workspace = revision
        .forked_workspace()
        .expect("a diverged implement workspace forks fresh");
    let revision_worktree = std::path::PathBuf::from(&revision_workspace.worktree_path);
    assert!(
        branch_contains(&repo_root, &revision_workspace.branch, &round_one),
        "the revision fork must contain round 1's commit {round_one}",
    );
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, revision)
        .await
        .unwrap();

    let round_two = commit_in(&revision_worktree, "round-two.txt", "round two fix");
    record_finished_run(
        &db,
        "run-commit-3",
        "commit",
        "post",
        "commit",
        &revision_worktree,
    );

    // --- The third review fork must carry both rounds.
    let third_review = prepare_review_fork(&db, &config);
    let third_review_branch = third_review
        .forked_workspace()
        .expect("review forks a workspace")
        .branch
        .clone();
    for (label, commit) in [("round 1", &round_one), ("round 2", &round_two)] {
        assert!(
            branch_contains(&repo_root, &third_review_branch, commit),
            "the third review fork must contain {label}'s commit {commit}",
        );
    }
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *third_review)
        .await
        .unwrap();

    fake_daemon.await.unwrap();
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// The narrow regression: a resumed revision rewinds the task's branch, the
/// round's commit lands in the other workspace, and the branch field must be
/// reconciled onto the branch that actually holds the commit before anything
/// forks from it.
#[tokio::test]
async fn resumed_revision_committing_in_another_workspace_reconciles_the_task_branch() {
    let config = test_config("work-tip-resumed-revision-elsewhere");
    let (repo_root, db) = init_fixture("work-tip-resumed-revision-elsewhere", &config);
    let creation_branch = format!("task-{TASK_ID}");
    let creation_worktree = repo_root.join(".kanna-worktrees").join(&creation_branch);
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &creation_worktree);

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 2).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let replacements = crate::session_replacements::SessionReplacements::default();

    let review = prepare_review_fork(&db, &config);
    let review_branch = review.forked_workspace().unwrap().branch.clone();
    let review_worktree = review.forked_workspace().unwrap().worktree_path.clone();
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *review)
        .await
        .unwrap();

    fail_latest_run(&db, "Add the missing coverage.");
    let revision = prepare_resumed_revision(
        &db,
        &config,
        &claude_config_dir,
        "Add the missing coverage.",
    );
    assert!(revision.resumed_workspace().is_some());
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, revision)
        .await
        .unwrap();
    assert_eq!(task_branch(&db), creation_branch);

    // The commit lands in the review workspace, not the one the task names.
    let landed = commit_in(
        std::path::Path::new(&review_worktree),
        "fix.txt",
        "revision fix",
    );
    record_finished_run(
        &db,
        "run-commit-2",
        "commit",
        "post",
        "commit",
        &creation_worktree,
    );

    let next_review = prepare_review_fork(&db, &config);

    // The branch field now names the branch that holds the committed tip...
    assert_eq!(task_branch(&db), review_branch);
    // ...and the fork cut from it, so nothing was dropped.
    let forked = next_review.forked_workspace().expect("review forks");
    assert!(branch_contains(&repo_root, &forked.branch, &landed));
    assert!(std::path::Path::new(&forked.worktree_path)
        .join("fix.txt")
        .is_file());

    let _ = crate::task_creator::worktree::remove_prepared_worktree(
        &forked.worktree_path,
        &forked.branch,
    );
    drop(next_review);
    fake_daemon.await.unwrap();
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Siblings that each hold work the other lacks have no latest tip. Picking
/// one would drop the other's commits, so the task keeps the branch it has and
/// the divergence is reported rather than guessed at.
#[test]
fn diverged_sibling_workspaces_leave_the_task_branch_alone() {
    let config = test_config("work-tip-diverged");
    let (repo_root, db) = init_fixture("work-tip-diverged", &config);
    let creation_branch = format!("task-{TASK_ID}");
    let creation_worktree = repo_root.join(".kanna-worktrees").join(&creation_branch);

    let sibling_branch = format!("task-{TASK_ID}-2");
    let sibling_worktree = repo_root.join(".kanna-worktrees").join(&sibling_branch);
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            &sibling_branch,
            sibling_worktree.to_string_lossy().as_ref(),
            &creation_branch,
        ],
    );
    record_finished_run(
        &db,
        "run-review",
        "review",
        "main",
        "review",
        &sibling_worktree,
    );
    commit_in(&sibling_worktree, "sibling.txt", "sibling work");
    commit_in(&creation_worktree, "creation.txt", "creation work");

    let workspaces = task_workspaces(
        &db,
        repo_root.to_string_lossy().as_ref(),
        TASK_ID,
        Some(&creation_branch),
    )
    .unwrap();
    assert!(matches!(
        resolve_task_work_tip(repo_root.to_string_lossy().as_ref(), &workspaces),
        WorkTipResolution::Diverged(_)
    ));

    let mut source_task = db.get_task_stage_source(TASK_ID).unwrap().unwrap();
    reconcile_task_work_branch(
        &db,
        repo_root.to_string_lossy().as_ref(),
        TASK_ID,
        &mut source_task,
    )
    .unwrap();
    assert_eq!(
        source_task.branch.as_deref(),
        Some(creation_branch.as_str())
    );
    assert_eq!(task_branch(&db), creation_branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}

/// The ordinary case: right after a fork several branches sit on the same
/// commit, and the task must stay where it is rather than drift sideways.
#[test]
fn equal_tips_keep_the_task_on_its_own_branch() {
    let config = test_config("work-tip-equal-tips");
    let (repo_root, db) = init_fixture("work-tip-equal-tips", &config);
    let creation_branch = format!("task-{TASK_ID}");
    let sibling_branch = format!("task-{TASK_ID}-2");
    let sibling_worktree = repo_root.join(".kanna-worktrees").join(&sibling_branch);
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            &sibling_branch,
            sibling_worktree.to_string_lossy().as_ref(),
            &creation_branch,
        ],
    );
    record_finished_run(
        &db,
        "run-review",
        "review",
        "main",
        "review",
        &sibling_worktree,
    );

    let mut source_task = db.get_task_stage_source(TASK_ID).unwrap().unwrap();
    source_task.branch = Some(sibling_branch.clone());
    db.update_pipeline_item_branch(TASK_ID, &sibling_branch)
        .unwrap();
    reconcile_task_work_branch(
        &db,
        repo_root.to_string_lossy().as_ref(),
        TASK_ID,
        &mut source_task,
    )
    .unwrap();
    assert_eq!(source_task.branch.as_deref(), Some(sibling_branch.as_str()));
    assert_eq!(task_branch(&db), sibling_branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}

/// `pipeline_item.branch` names the task's *workspace*, and an agent may
/// rename the branch checked out there — the PR agent does, recording the new
/// name in `pipeline_item.pr_branch`. That is not a workspace move, so the
/// field must stay put; the fork start point follows the rename through the
/// worktree on its own.
#[test]
fn a_renamed_branch_in_the_same_workspace_is_not_a_reconcile() {
    let config = test_config("work-tip-renamed-branch");
    let (repo_root, db) = init_fixture("work-tip-renamed-branch", &config);
    let creation_branch = format!("task-{TASK_ID}");
    let creation_worktree = repo_root.join(".kanna-worktrees").join(&creation_branch);
    run_git_in(
        &creation_worktree,
        &["branch", "-m", "feat/renamed-by-agent"],
    );
    commit_in(&creation_worktree, "renamed.txt", "work after the rename");

    let mut source_task = db.get_task_stage_source(TASK_ID).unwrap().unwrap();
    reconcile_task_work_branch(
        &db,
        repo_root.to_string_lossy().as_ref(),
        TASK_ID,
        &mut source_task,
    )
    .unwrap();
    assert_eq!(
        source_task.branch.as_deref(),
        Some(creation_branch.as_str())
    );
    assert_eq!(task_branch(&db), creation_branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}
