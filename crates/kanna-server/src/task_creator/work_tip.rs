//! The task's committed work tip, and reconciling `pipeline_item.branch` onto
//! the branch that holds it.
//!
//! A task's work does not live on one branch for its whole life: every stage
//! transition forks a fresh workspace, and a revision may adopt an older one.
//! `pipeline_item.branch` records the workspace the engine last *placed* the
//! task in — which is not, on its own, the branch holding the newest commit.
//! When a round's commit lands on a workspace that field no longer names,
//! forking the next workspace from the field silently drops it: the next
//! reviewer reads code without the previous round's fix and re-raises the
//! identical finding, so the revision budget burns without converging.
//!
//! Observed live on 2026-08-21: a resumed revision rewound `pipeline_item.branch`
//! to the implement workspace while each round's commit landed on the reviewer's
//! fork, and three consecutive review forks were cut from the same pre-revision
//! base. The regression is covered by the tests in this module.
//!
//! Which branch holds the tip is therefore a question for git, not for the run
//! records: the engine cannot see where an agent `cd`s. Every stage
//! preparation resolves the tip across all of the task's known workspaces and
//! moves the task's branch onto it before anything forks.

use crate::db::{Db, TaskStageSource};
use std::path::Path;
use std::process::Command;

use super::resume::current_branch;
use super::worktree::{local_branch_exists, resolve_current_source_worktree_branch};

/// One branch the task's work might be sitting on, and where it is checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskWorkspace {
    pub(crate) branch: String,
    /// The worktree directory the branch was found in, when it still exists.
    pub(crate) worktree_path: Option<String>,
}

/// The task's newest committed work, and the workspace holding it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskWorkTip {
    pub(crate) branch: String,
    pub(crate) worktree_path: Option<String>,
    pub(crate) commit: String,
}

/// Every workspace branch the task is known to have used, most recently used
/// first, starting with the branch the task currently names.
///
/// The task's own branch is resolved through its worktree so a rename (the PR
/// agent does this) is followed. Every other candidate comes from a recorded
/// `stage_run.cwd`: each stage run names the worktree it ran in, so the union
/// covers every workspace the task has ever had — including one whose branch
/// the task moved off.
pub(crate) fn task_workspaces(
    db: &Db,
    repo_path: &str,
    task_id: &str,
    current_branch_name: Option<&str>,
) -> Result<Vec<TaskWorkspace>, String> {
    let mut workspaces: Vec<TaskWorkspace> = Vec::new();
    let mut push = |branch: String, worktree_path: Option<String>| {
        if branch.is_empty() {
            return;
        }
        match workspaces
            .iter_mut()
            .find(|workspace| workspace.branch == branch)
        {
            Some(existing) => {
                if existing.worktree_path.is_none() {
                    existing.worktree_path = worktree_path;
                }
            }
            None => workspaces.push(TaskWorkspace {
                branch,
                worktree_path,
            }),
        }
    };

    if let Some(stored_branch) = current_branch_name {
        let worktree_path = Path::new(repo_path)
            .join(".kanna-worktrees")
            .join(stored_branch);
        let resolved = resolve_current_source_worktree_branch(repo_path, Some(stored_branch))
            .unwrap_or_else(|| stored_branch.to_string());
        push(
            resolved,
            worktree_path
                .is_dir()
                .then(|| worktree_path.to_string_lossy().to_string()),
        );
    }

    let cwds = db
        .task_stage_run_cwds(task_id)
        .map_err(|error| format!("db error: {error}"))?;
    for cwd in cwds {
        let path = Path::new(&cwd);
        if path.is_dir() {
            if let Some(branch) = current_branch(&cwd) {
                push(branch, Some(cwd.clone()));
            }
            continue;
        }
        // The worktree is gone (a stage teardown removed it, or the task was
        // reopened). Its branch may still hold commits, and worktree
        // directories are named for the branch they were created on.
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if local_branch_exists(repo_path, name) {
                push(name.to_string(), None);
            }
        }
    }

    Ok(workspaces)
}

/// The newest committed tip across the task's workspaces: the one candidate
/// that contains every other candidate.
///
/// Ties (several branches on the same commit — the ordinary state right after
/// a fork) resolve to the first candidate, which is the task's own branch, so
/// a task is never moved sideways onto an equal-tip sibling.
///
/// Genuinely diverged siblings, each holding work the other lacks, have no
/// "latest" tip: choosing one would drop the other's commits, which is the
/// failure this module exists to prevent. That is reported to the caller as
/// `Diverged` rather than guessed at.
pub(crate) enum WorkTipResolution {
    Tip(TaskWorkTip),
    Diverged(Vec<TaskWorkTip>),
    Unknown,
}

pub(crate) fn resolve_task_work_tip(
    repo_path: &str,
    workspaces: &[TaskWorkspace],
) -> WorkTipResolution {
    let tips: Vec<TaskWorkTip> = workspaces
        .iter()
        .filter_map(|workspace| {
            rev_parse_branch(repo_path, &workspace.branch).map(|commit| TaskWorkTip {
                branch: workspace.branch.clone(),
                worktree_path: workspace.worktree_path.clone(),
                commit,
            })
        })
        .collect();
    if tips.is_empty() {
        return WorkTipResolution::Unknown;
    }
    let dominant = tips.iter().find(|candidate| {
        tips.iter()
            .all(|other| is_ancestor(repo_path, &other.commit, &candidate.commit))
    });
    match dominant {
        Some(tip) => WorkTipResolution::Tip(tip.clone()),
        None => WorkTipResolution::Diverged(tips),
    }
}

/// Move the task's workspace identity onto the branch holding its latest
/// committed tip, so that everything downstream — the fork start point, the
/// post's worktree, `$SOURCE_WORKTREE`, the resume preconditions, the departed
/// workspace's teardown — reads the same branch git does.
///
/// A no-op in the ordinary case, where the task's own branch already holds the
/// tip. `source_task` is updated in place so the caller's already-loaded view
/// does not go stale.
pub(crate) fn reconcile_task_work_branch(
    db: &Db,
    repo_path: &str,
    task_id: &str,
    source_task: &mut TaskStageSource,
) -> Result<(), String> {
    let workspaces = task_workspaces(db, repo_path, task_id, source_task.branch.as_deref())?;
    let tip = match resolve_task_work_tip(repo_path, &workspaces) {
        WorkTipResolution::Tip(tip) => tip,
        WorkTipResolution::Diverged(tips) => {
            // Non-wedging by design: the task keeps the branch it has, and the
            // divergence is reported loudly rather than resolved by dropping
            // one side's commits.
            log::error!(
                "task {task_id} has diverged workspace branches; no single branch holds its \
                 committed work, so forks keep using {current:?}. Diverged tips: {list}",
                current = source_task.branch,
                list = tips
                    .iter()
                    .map(|tip| format!("{}@{}", tip.branch, &tip.commit[..tip.commit.len().min(8)]))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            return Ok(());
        }
        WorkTipResolution::Unknown => return Ok(()),
    };
    if source_task.branch.as_deref() == Some(tip.branch.as_str()) {
        return Ok(());
    }
    // The tip is in the workspace the task already occupies, under a branch
    // name an agent renamed (the PR agent does exactly this, and records the
    // new name in `pipeline_item.pr_branch`). `pipeline_item.branch` names the
    // *workspace*, and the fork start point already follows the rename through
    // the worktree — moving the field here would rewrite an unrelated
    // convention. Only a tip in a different workspace is a reconcile.
    let current_worktree = source_task
        .branch
        .as_deref()
        .map(|branch| Path::new(repo_path).join(".kanna-worktrees").join(branch));
    if let (Some(current), Some(tip_worktree)) = (&current_worktree, &tip.worktree_path) {
        if super::resume::same_cwd(&current.to_string_lossy(), tip_worktree) {
            return Ok(());
        }
    }

    log::warn!(
        "task {task_id} committed work is on {} ({}), not on its recorded branch {:?}; \
         moving the task's workspace there so the next fork cannot drop it",
        tip.branch,
        &tip.commit[..tip.commit.len().min(8)],
        source_task.branch,
    );
    let moved = db
        .update_pipeline_item_branch(task_id, &tip.branch)
        .map_err(|error| format!("db error: {error}"))?;
    if !moved {
        // Closed between load and reconcile; the caller's own closed check
        // reports it.
        return Ok(());
    }
    if let Some(worktree_path) = &tip.worktree_path {
        db.upsert_worktree(
            &format!("wt-{task_id}"),
            task_id,
            worktree_path,
            &tip.branch,
        )
        .map_err(|error| format!("db error: {error}"))?;
    }
    source_task.branch = Some(tip.branch);
    Ok(())
}

fn rev_parse_branch(repo_path: &str, branch: &str) -> Option<String> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(repo_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!commit.is_empty()).then_some(commit)
}

/// Whether `ancestor` is reachable from `descendant` (true when equal).
fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> bool {
    if ancestor == descendant {
        return true;
    }
    Command::new("git")
        .args([
            "merge-base",
            "--is-ancestor",
            "--end-of-options",
            ancestor,
            descendant,
        ])
        .current_dir(repo_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
