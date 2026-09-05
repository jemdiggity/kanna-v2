//! Locating, staging and materializing the agent session state a transfer
//! carries.
//!
//! The source half is the Rust form of `planTransferredSessionArtifacts` /
//! `stagePlannedSessionArtifacts`. Locating stays separated from staging for
//! the reason it was separated in the renderer: the source has to prove it
//! *can* ship the conversation before it does anything destructive to the live
//! session, so a transfer that cannot fails with the source task still running.
//!
//! The receiver half hands the payload's artifacts to `transfer_artifact`,
//! whose openat/`O_NOFOLLOW`/renameat-no-replace discipline is unchanged by the
//! move — it was already Rust, and it is the security boundary between a peer's
//! payload and this machine's home directory.

use super::payload::{
    required_session_artifact_kind, MissingSessionArtifact, TransferArtifactKind,
    TransferArtifactMaterialization, TransferArtifactPayload,
    OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH, OPENCODE_SESSION_EXPORT_FILENAME,
};
use std::path::{Path, PathBuf};

/// Providers whose session state is a directory under `$HOME`, archived whole.
#[derive(Debug)]
pub struct SessionArchiveConfig {
    provider: &'static str,
    source_root_relative_path: &'static str,
    archive_filename: &'static str,
    artifact_suffix: &'static str,
}

const SESSION_ARCHIVES: &[SessionArchiveConfig] = &[
    SessionArchiveConfig {
        provider: "claude",
        source_root_relative_path: ".claude/tasks",
        archive_filename: "claude-session.tar.gz",
        artifact_suffix: "claude-session",
    },
    SessionArchiveConfig {
        provider: "copilot",
        source_root_relative_path: ".copilot/session-state",
        archive_filename: "copilot-session.tar.gz",
        artifact_suffix: "copilot-session",
    },
];

#[derive(Debug)]
pub struct LocatedFileArtifact {
    pub absolute_path: PathBuf,
    pub home_rel_path: String,
    pub filename: String,
    pub kind: TransferArtifactKind,
    pub artifact_suffix: &'static str,
}

/// Everything a transfer of this task will ship, located but not yet staged.
#[derive(Debug)]
pub struct SessionArtifactPlan {
    pub session_id: String,
    pub provider: String,
    /// `Some` when the provider keeps a session directory *and* it exists.
    pub archive: Option<(&'static SessionArchiveConfig, PathBuf)>,
    pub files: Vec<LocatedFileArtifact>,
    /// OpenCode's conversation is not a file on disk — it lives in a shared
    /// SQLite store — so it is staged by asking the CLI to export it rather
    /// than by locating a path. Carries the worktree the export runs in, which
    /// matters because `opencode export` is project-scoped.
    pub opencode_export: Option<PathBuf>,
}

/// The task identity a plan was located against; a change invalidates it.
///
/// JSON-encoded rather than joined on a separator. The value is only ever
/// compared, never parsed, and encoding is the one form no component's own
/// content can forge a match through: `agent_type` carries a repo-supplied
/// agent name, so no single separator is provably absent from every component,
/// and one that appears inside a component lets two different identities
/// render identically. (The renderer's version of this joined on a literal NUL,
/// which made the whole source file read as binary to `grep`; encoding avoids
/// choosing a separator at all.)
pub fn session_plan_identity(
    agent_session_id: Option<&str>,
    agent_provider: Option<&str>,
    agent_type: Option<&str>,
    branch: Option<&str>,
) -> String {
    serde_json::json!([agent_session_id, agent_provider, agent_type, branch]).to_string()
}

/// Locates the session state this task's payload will promise.
///
/// `Ok(None)` means the task legitimately has nothing to ship. A promise this
/// task cannot keep — a resumable session with no artifact to back it — is
/// `Err(MissingSessionArtifact)`, which fails the transfer rather than shipping
/// a `resume_session_id` with an empty artifact list. That silent drop is what
/// left a 2.1 MB conversation on the source machine on 2026-08-06.
pub fn plan_session_artifacts(
    home: &Path,
    agent_session_id: Option<&str>,
    agent_provider: Option<&str>,
    agent_type: Option<&str>,
    worktree_path: Option<&Path>,
    task_id: &str,
) -> Result<Option<SessionArtifactPlan>, MissingSessionArtifact> {
    let Some(provider) = agent_provider else {
        return Ok(None);
    };
    // OpenCode is the one provider whose session id the task row cannot carry,
    // so its plan discovers the id instead of being handed one.
    if provider == "opencode" {
        return plan_opencode_export(agent_type, worktree_path);
    }
    let Some(session_id) = agent_session_id else {
        return Ok(None);
    };
    let required = required_session_artifact_kind(agent_type, Some(provider), Some(session_id));
    let missing = |detail: String| {
        MissingSessionArtifact(format!(
            "task {task_id} resumes {provider} session {session_id} but {detail}"
        ))
    };

    if provider == "codex" {
        return match locate_codex_rollout(home, session_id) {
            Some(rollout) => Ok(Some(SessionArtifactPlan {
                session_id: session_id.to_string(),
                provider: provider.to_string(),
                archive: None,
                files: vec![rollout],
                opencode_export: None,
            })),
            None if required.is_some() => Err(missing(
                "its rollout could not be found under ~/.codex/sessions".into(),
            )),
            None => Ok(None),
        };
    }

    let Some(config) = SESSION_ARCHIVES
        .iter()
        .find(|candidate| candidate.provider == provider)
    else {
        // No transferable session state exists for this provider at all, so an
        // empty artifact list is the truth rather than a silent drop.
        return Ok(None);
    };
    let source_root = home.join(config.source_root_relative_path);
    let mut files = Vec::new();

    if provider == "claude" {
        // The `~/.claude/tasks/<id>` archive holds only lock and highwatermark
        // state. The conversation itself lives in the cwd-keyed transcript, so
        // ship it alongside — neither one is sufficient on its own.
        let transcript = match worktree_path {
            Some(worktree_path) => crate::transfer_artifact::locate_claude_transcript_at_home(
                home,
                worktree_path,
                session_id,
            )
            .map_err(|error| missing(format!("its transcript could not be looked up: {error}")))?,
            None => None,
        };
        match transcript {
            Some(transcript) => files.push(LocatedFileArtifact {
                absolute_path: transcript.absolute_path,
                home_rel_path: transcript.home_rel_path,
                filename: transcript.filename,
                kind: TransferArtifactKind::SessionTranscript,
                artifact_suffix: "claude-transcript",
            }),
            None if required == Some(TransferArtifactKind::SessionTranscript) => {
                return Err(missing(match worktree_path {
                    Some(worktree_path) => format!(
                        "no transcript exists for its worktree {}",
                        worktree_path.display()
                    ),
                    None => "it has no worktree to derive a transcript path from".into(),
                }));
            }
            None => {}
        }
    }

    if !source_root.join(session_id).is_dir() {
        if required == Some(TransferArtifactKind::SessionArchive) {
            return Err(missing(format!(
                "its session state is missing from {}",
                source_root.display()
            )));
        }
        return Ok((!files.is_empty()).then_some(SessionArtifactPlan {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            archive: None,
            files,
            opencode_export: None,
        }));
    }

    Ok(Some(SessionArtifactPlan {
        session_id: session_id.to_string(),
        provider: provider.to_string(),
        archive: Some((config, source_root)),
        files,
        opencode_export: None,
    }))
}

/// OpenCode's half of the plan: find the session this worktree has been talking
/// to, and promise to export it.
///
/// Unlike every other provider Kanna resumes, OpenCode's id cannot be known
/// before the agent runs: `opencode run` has no flag that *assigns* a session id
/// (`--session` with an unknown id is "Session not found"), and the id never
/// appears in the terminal, so nothing upstream of here has it to persist. What
/// OpenCode does record is the session's working directory, and a task's
/// worktree is unique to that task — so the session is looked up by worktree at
/// transfer time, when it is guaranteed to exist.
///
/// The absence of a session is a legitimate absence — the agent never got a turn
/// in — and is reported as "nothing to ship". Once a session *does* exist the
/// export is required, because shipping a resume id with no conversation behind
/// it is the exact shape that lost 2.1 MB of Claude transcript.
///
/// Scoped deliberately to the transfer path: making Kanna track OpenCode session
/// ids for every task is a larger change than shipping the conversation, and
/// this lookup does not stand in its way.
fn plan_opencode_export(
    agent_type: Option<&str>,
    worktree_path: Option<&Path>,
) -> Result<Option<SessionArtifactPlan>, MissingSessionArtifact> {
    if agent_type != Some("pty") {
        log::debug!("opencode transfer plan: agent_type is {agent_type:?}, not a PTY session");
        return Ok(None);
    }
    let Some(worktree_path) = worktree_path.filter(|path| path.is_dir()) else {
        log::warn!(
            "opencode transfer plan: no worktree directory to look a session up in ({worktree_path:?})"
        );
        return Ok(None);
    };
    let Some(session_id) = super::git::latest_opencode_session_for_worktree(worktree_path)
        .map_err(MissingSessionArtifact)?
    else {
        log::info!(
            "opencode transfer plan: no session recorded for {}",
            worktree_path.display()
        );
        return Ok(None);
    };
    log::info!(
        "opencode transfer plan: shipping session {session_id} from {}",
        worktree_path.display()
    );
    Ok(Some(SessionArtifactPlan {
        session_id,
        provider: "opencode".to_string(),
        archive: None,
        files: Vec::new(),
        opencode_export: Some(worktree_path.to_path_buf()),
    }))
}

/// Codex names a rollout `rollout-<timestamp>-<session-id>.jsonl` under a
/// date-partitioned directory, so it is found by scanning rather than by
/// construction — the timestamp is not derivable from the session id.
fn locate_codex_rollout(home: &Path, session_id: &str) -> Option<LocatedFileArtifact> {
    let sessions_root = home.join(".codex").join("sessions");
    let suffix = format!("{session_id}.jsonl");
    let names = |directory: &Path| -> Vec<String> {
        std::fs::read_dir(directory)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    for year in names(&sessions_root) {
        let year_path = sessions_root.join(&year);
        for month in names(&year_path) {
            let month_path = year_path.join(&month);
            for day in names(&month_path) {
                let day_path = month_path.join(&day);
                for filename in names(&day_path) {
                    if !filename.ends_with(&suffix) {
                        continue;
                    }
                    return Some(LocatedFileArtifact {
                        absolute_path: day_path.join(&filename),
                        home_rel_path: format!(".codex/sessions/{year}/{month}/{day}/{filename}"),
                        filename,
                        kind: TransferArtifactKind::SessionRollout,
                        artifact_suffix: "codex-rollout",
                    });
                }
            }
        }
    }
    None
}

/// Where a staged, engine-owned archive is written before the sidecar takes it.
pub fn staging_path(staging_dir: &Path, transfer_id: &str, suffix: &str) -> PathBuf {
    staging_dir.join(format!("kanna-transfer-{transfer_id}-{suffix}.tar.gz"))
}

pub fn bundle_staging_path(staging_dir: &Path, transfer_id: &str) -> PathBuf {
    staging_dir.join(format!("kanna-transfer-{transfer_id}.bundle"))
}

/// The artifact ids the payload declares. Derived from the transfer id so a
/// re-staged artifact replaces its predecessor rather than accumulating.
pub fn artifact_id(transfer_id: &str, suffix: &str) -> String {
    format!("{transfer_id}-{suffix}")
}

pub struct StagedArtifact {
    pub payload: TransferArtifactPayload,
    pub source_path: PathBuf,
    /// Whether the sidecar takes ownership of the file (and deletes it with
    /// the transfer) or only references it in place.
    pub owned: bool,
}

/// Builds the artifact list a plan will ship, creating any archives it needs.
pub fn stage_plan(
    plan: &SessionArtifactPlan,
    transfer_id: &str,
    staging_dir: &Path,
) -> Result<Vec<StagedArtifact>, String> {
    let mut staged = Vec::new();
    if let Some(worktree_path) = &plan.opencode_export {
        // Deliberately short, and unique by randomness rather than by naming
        // the transfer: a staged `owned` artifact is stored under
        // `<artifact-id>-<basename>` on the source and then fetched into
        // `<artifact-id>-<that name>` on the receiver, so the artifact id is
        // spent twice and a descriptive basename pushes the receiver's filename
        // past the 255-byte limit — which surfaces only as `File name too long`
        // mid-transfer.
        let export_path = staging_dir.join(format!(
            "kanna-oc-session-{}.json",
            super::queue::unique_work_nonce()
        ));
        super::git::export_opencode_session(worktree_path, &plan.session_id, &export_path)?;
        staged.push(StagedArtifact {
            payload: TransferArtifactPayload {
                artifact_id: artifact_id(transfer_id, "opencode-session"),
                filename: OPENCODE_SESSION_EXPORT_FILENAME.to_string(),
                provider: plan.provider.clone(),
                kind: TransferArtifactKind::SessionExport,
                home_rel_path: OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH.to_string(),
                materialization: TransferArtifactMaterialization::OpencodeImport,
            },
            source_path: export_path,
            owned: true,
        });
        return Ok(staged);
    }
    if let Some((config, source_root)) = &plan.archive {
        let archive_path = staging_path(staging_dir, transfer_id, config.artifact_suffix);
        super::git::create_session_archive(source_root, &plan.session_id, &archive_path)?;
        staged.push(StagedArtifact {
            payload: TransferArtifactPayload {
                artifact_id: artifact_id(transfer_id, config.artifact_suffix),
                filename: config.archive_filename.to_string(),
                provider: plan.provider.clone(),
                kind: TransferArtifactKind::SessionArchive,
                home_rel_path: format!("{}/{}", config.source_root_relative_path, plan.session_id),
                materialization: TransferArtifactMaterialization::ExtractTarGz,
            },
            source_path: archive_path,
            owned: true,
        });
    }
    for file in &plan.files {
        staged.push(StagedArtifact {
            payload: TransferArtifactPayload {
                artifact_id: artifact_id(transfer_id, file.artifact_suffix),
                filename: file.filename.clone(),
                provider: plan.provider.clone(),
                kind: file.kind,
                home_rel_path: file.home_rel_path.clone(),
                materialization: TransferArtifactMaterialization::CopyFile,
            },
            source_path: file.absolute_path.clone(),
            // Referenced in place: this is the live transcript or rollout, and
            // deleting it with the transfer would destroy the source's own
            // history.
            owned: false,
        });
    }
    Ok(staged)
}

/// Where the destination worktree for a transfer will be, before the task that
/// owns it exists. Deterministic because the transcript has to be re-keyed to
/// the destination's own cwd slug *before* the agent spawns with `--resume`.
pub fn destination_worktree_path(repo_path: &Path, destination_task_id: &str) -> PathBuf {
    repo_path
        .join(".kanna-worktrees")
        .join(format!("task-{destination_task_id}"))
}

/// The destination task id a transfer will use, derived from the transfer id so
/// both the worktree path and the task creation can name it before either
/// exists.
pub fn destination_task_id(transfer_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("kanna-transfer-destination:{transfer_id}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Decides whether an incoming payload may be imported at all, before any
/// artifact is fetched.
///
/// A payload that promises a resumable session and ships no way to resume it
/// must not be imported: minting a fresh session here is what silently left the
/// conversation behind on the source machine.
pub fn assert_importable(
    transfer_id: &str,
    agent_type: Option<&str>,
    provider: Option<&str>,
    resume_session_id: Option<&str>,
    artifacts: &[TransferArtifactPayload],
) -> Result<(), MissingSessionArtifact> {
    let Some(required) = required_session_artifact_kind(agent_type, provider, resume_session_id)
    else {
        return Ok(());
    };
    let provider = provider.unwrap_or_default();
    let carries = artifacts
        .iter()
        .any(|artifact| artifact.provider == provider && artifact.kind == required);
    if carries {
        return Ok(());
    }
    Err(MissingSessionArtifact(format!(
        "incoming transfer {transfer_id} resumes {provider} session {} but carries no {} artifact",
        resume_session_id.unwrap_or_default(),
        required.as_str(),
    )))
}

/// Whether an already-present destination means the resume must be abandoned.
///
/// The transcript *is* the conversation, so it decides when one shipped; a
/// pre-existing `~/.claude/tasks/<id>` lock directory must not veto it.
pub fn resume_survives_existing_destination(
    artifacts: &[TransferArtifactPayload],
    materialized: &[(String, bool)],
) -> bool {
    let decisive = artifacts
        .iter()
        .find(|artifact| artifact.kind == TransferArtifactKind::SessionTranscript)
        .or_else(|| {
            artifacts
                .iter()
                .find(|artifact| artifact.kind == TransferArtifactKind::SessionExport)
        })
        .or_else(|| {
            artifacts
                .iter()
                .find(|artifact| artifact.kind == TransferArtifactKind::SessionArchive)
        })
        .or_else(|| artifacts.first());
    let Some(decisive) = decisive else {
        return false;
    };
    // The question an occupied destination answers is not "did we write?" but
    // "could what is already there be a *different* conversation?".
    //
    // A transcript and a Codex rollout are content-addressed: the receiver
    // derives `~/.claude/projects/<slug>/<session-id>.jsonl` itself, and a
    // rollout's filename carries both the session id and the timestamp it was
    // opened at. Nothing else can occupy either path, so an occupied one is
    // this transfer's own earlier attempt and the conversation is present.
    // Requiring a write there would abandon the resume on every retry —
    // exactly the regression the materialization phase claim exists to stop,
    // and Codex would hit it silently because nothing else distinguishes it.
    //
    // A session *archive* and an OpenCode *export* land in namespaces the
    // receiver may already own with different content: `~/.claude/tasks/<id>`
    // holds lock and highwatermark state that can exist without any
    // conversation (which is why the transcript had to be shipped at all), and
    // an OpenCode id resolves in a shared store this machine writes from every
    // other task. There, an untouched destination really can mean the
    // conversation did not cross, and resuming anyway would attach this task to
    // whatever was already there.
    match decisive.kind {
        TransferArtifactKind::SessionTranscript | TransferArtifactKind::SessionRollout => true,
        TransferArtifactKind::SessionArchive | TransferArtifactKind::SessionExport => materialized
            .iter()
            .find(|(artifact_id, _)| artifact_id == &decisive.artifact_id)
            .map(|(_, wrote)| *wrote)
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(kind: TransferArtifactKind, artifact_id: &str) -> TransferArtifactPayload {
        TransferArtifactPayload {
            artifact_id: artifact_id.to_string(),
            filename: "f".into(),
            provider: "claude".into(),
            kind,
            home_rel_path: "p".into(),
            materialization: TransferArtifactMaterialization::CopyFile,
        }
    }

    #[test]
    fn a_promise_of_a_resumable_session_with_nothing_to_back_it_is_refused() {
        let error = assert_importable(
            "t-1",
            Some("pty"),
            Some("claude"),
            Some("364643cc-5e6d-48fc-86ca-ca7764380900"),
            &[artifact(TransferArtifactKind::SessionArchive, "a")],
        )
        .expect_err("a claude PTY transfer without a transcript was importable");
        assert!(error.0.contains("session-transcript"), "{}", error.0);

        // The archive alone is enough for a provider whose conversation lives
        // in it, and a task with no session to resume promises nothing.
        assert!(assert_importable(
            "t-1",
            Some("pty"),
            Some("copilot"),
            Some("session-1"),
            &[TransferArtifactPayload {
                provider: "copilot".into(),
                ..artifact(TransferArtifactKind::SessionArchive, "a")
            }],
        )
        .is_ok());
        assert!(assert_importable("t-1", Some("pty"), Some("claude"), None, &[]).is_ok());
    }

    /// A `~/.claude/tasks/<id>` lock directory that already exists is not a
    /// reason to abandon a conversation that did cross.
    #[test]
    fn an_existing_lock_directory_does_not_veto_a_transcript_that_shipped() {
        let artifacts = [
            artifact(TransferArtifactKind::SessionArchive, "archive"),
            artifact(TransferArtifactKind::SessionTranscript, "transcript"),
        ];
        assert!(resume_survives_existing_destination(
            &artifacts,
            &[("archive".into(), false), ("transcript".into(), true)],
        ));

        // With only the archive to go on, an untouched destination does mean
        // the session state could not be established at all.
        let archive_only = [artifact(TransferArtifactKind::SessionArchive, "archive")];
        assert!(!resume_survives_existing_destination(
            &archive_only,
            &[("archive".into(), false)],
        ));
        assert!(resume_survives_existing_destination(
            &archive_only,
            &[("archive".into(), true)],
        ));
    }

    #[test]
    fn the_destination_worktree_is_nameable_before_the_task_exists() {
        let task_id = destination_task_id("transfer-1");
        assert_eq!(task_id.len(), 64);
        assert_eq!(task_id, destination_task_id("transfer-1"));
        assert_ne!(task_id, destination_task_id("transfer-2"));
        assert_eq!(
            destination_worktree_path(Path::new("/repos/kanna"), &task_id),
            Path::new("/repos/kanna/.kanna-worktrees").join(format!("task-{task_id}")),
        );
    }

    #[test]
    fn a_claude_task_whose_transcript_is_absent_fails_instead_of_shipping_an_empty_promise() {
        let home = tempfile::tempdir().expect("home");
        let error = plan_session_artifacts(
            home.path(),
            Some("364643cc-5e6d-48fc-86ca-ca7764380900"),
            Some("claude"),
            Some("pty"),
            Some(&home.path().join("worktree")),
            "task-1",
        )
        .expect_err("an absent transcript was reported as nothing to ship");
        assert!(error.0.contains("no transcript exists"), "{}", error.0);
    }

    /// An agent-mode task and a provider with nothing transferable both ship
    /// nothing, and that absence is legitimate rather than a failure.
    #[test]
    fn a_task_with_no_transferable_session_state_plans_nothing() {
        let home = tempfile::tempdir().expect("home");
        // An agent-mode task keeps nothing this contract can ship, and an
        // OpenCode task with no worktree has nowhere to look for a session —
        // OpenCode's plan is keyed by directory, not by a stored id.
        for (provider, agent_type) in [
            ("claude", "agent"),
            ("opencode", "agent"),
            ("opencode", "pty"),
        ] {
            let plan = plan_session_artifacts(
                home.path(),
                Some("364643cc-5e6d-48fc-86ca-ca7764380900"),
                Some(provider),
                Some(agent_type),
                Some(&home.path().join("worktree-that-does-not-exist")),
                "task-1",
            )
            .expect("no promise means no failure");
            assert!(plan.is_none(), "{provider}/{agent_type}");
        }
    }

    /// Points the provider-executable lookup at a stub `opencode`, so a test
    /// asserts what the plan does rather than whatever CLI the host happens to
    /// have. Serialized on the crate's env guard, because the lookup path is
    /// process-global.
    struct StubOpencode {
        _guard: tokio::sync::MutexGuard<'static, ()>,
        _dir: tempfile::TempDir,
    }

    impl StubOpencode {
        fn responding(script_body: &str) -> Self {
            let guard = crate::test_sidecar_guard_blocking();
            let dir = tempfile::tempdir().expect("stub dir");
            let stub = dir.path().join("opencode");
            std::fs::write(&stub, format!("#!/bin/sh\n{script_body}\n")).expect("write stub");
            std::fs::set_permissions(
                &stub,
                <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
            )
            .expect("chmod stub");
            unsafe {
                std::env::set_var("KANNA_TEST_PROVIDER_LOOKUP_PATH", dir.path());
            }
            Self {
                _guard: guard,
                _dir: dir,
            }
        }
    }

    impl Drop for StubOpencode {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("KANNA_TEST_PROVIDER_LOOKUP_PATH");
            }
        }
    }

    /// OpenCode is the one provider whose session id the task row cannot carry:
    /// `opencode run` never assigns or reports one, so `agent_session_id` is
    /// null for a task with a perfectly good conversation to ship. The plan has
    /// to reach the CLI rather than the row — and it must not short-circuit on
    /// the null id the way every other provider does.
    ///
    /// Asserted against a stub rather than the host's CLI. The previous version
    /// of this test accepted both its `Ok` and `Err` arms, so a discovery that
    /// stopped reaching the CLI at all would still have passed it.
    #[test]
    fn an_opencode_plan_is_reached_without_a_session_id_on_the_task_row() {
        let home = tempfile::tempdir().expect("home");
        let worktree = home.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        let resolved = worktree.canonicalize().expect("resolved worktree");
        let session_id = "ses_02645d9aaffeeOgwt2rbXIcTdp";
        let _stub = StubOpencode::responding(&format!(
            r#"printf '[{{"id":"{session_id}","directory":"{}","updated":2}}]'"#,
            resolved.display(),
        ));

        let plan = plan_session_artifacts(
            home.path(),
            None,
            Some("opencode"),
            Some("pty"),
            Some(&worktree),
            "task-1",
        )
        .expect("the null task-row id must not stop the lookup")
        .expect("the stub reported a session for this worktree");
        assert_eq!(plan.provider, "opencode");
        assert_eq!(plan.session_id, session_id);
        assert_eq!(plan.opencode_export.as_deref(), Some(worktree.as_path()));
    }

    /// A CLI that cannot be reached is not a conversation that does not exist.
    /// Reporting "nothing to ship" here is the shape that lost 2.1 MB of Claude
    /// transcript, so a failing lookup fails the plan.
    #[test]
    fn a_failing_opencode_lookup_fails_the_plan_rather_than_reporting_no_session() {
        let home = tempfile::tempdir().expect("home");
        let worktree = home.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        let _stub = StubOpencode::responding("echo 'store is locked' >&2; exit 1");

        let error = plan_session_artifacts(
            home.path(),
            None,
            Some("opencode"),
            Some("pty"),
            Some(&worktree),
            "task-1",
        )
        .expect_err("a broken CLI was reported as an absent session");
        assert!(error.0.contains("opencode"), "{}", error.0);
    }

    /// A worktree OpenCode has never seen genuinely has nothing to ship — the
    /// agent never got a turn in — and that is not a failure.
    #[test]
    fn an_opencode_worktree_with_no_session_plans_nothing() {
        let home = tempfile::tempdir().expect("home");
        let worktree = home.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        let _stub = StubOpencode::responding("printf '[]'");

        let plan = plan_session_artifacts(
            home.path(),
            None,
            Some("opencode"),
            Some("pty"),
            Some(&worktree),
            "task-1",
        )
        .expect("an empty listing is an absence, not a failure");
        assert!(plan.is_none());
    }

    /// The longest name any file this module puts on disk may have.
    ///
    /// POSIX `NAME_MAX` is 255 bytes and a transfer id is 64 hex characters, so
    /// names built from one are close enough to the limit that a descriptive
    /// suffix can cross it. Nothing in the module reads this — the names are
    /// built from fixed suffixes rather than checked at runtime — so it lives
    /// here, with the test that holds those suffixes to it.
    const MAX_STAGED_NAME_BYTES: usize = 255;

    /// Every name this module puts on disk stays inside `NAME_MAX`.
    ///
    /// A staged artifact used to be fetched into a name that spent the artifact
    /// id twice; with 64-hex transfer ids a real Claude session archive reached
    /// 261 bytes and killed the transfer with `ENAMETOOLONG` mid-flight. The
    /// sidecar bounds its own names now, and this bounds what it is handed —
    /// including the artifact ids, which are what the sidecar derives from.
    #[test]
    fn staged_names_and_artifact_ids_stay_inside_name_max() {
        let staging = Path::new("/tmp");
        // A transfer id is 64 hex characters.
        let transfer_id = "f".repeat(64);
        let suffixes = [
            "claude-session",
            "copilot-session",
            "claude-transcript",
            "codex-rollout",
            "opencode-session",
            "repo-bundle",
        ];

        for suffix in suffixes {
            let id = artifact_id(&transfer_id, suffix);
            assert!(
                id.len() <= MAX_STAGED_NAME_BYTES,
                "artifact id {id} is {} bytes",
                id.len(),
            );
            let staged = staging_path(staging, &transfer_id, suffix);
            let name = staged.file_name().expect("a file name");
            assert!(
                name.len() <= MAX_STAGED_NAME_BYTES,
                "staged name {name:?} is {} bytes",
                name.len(),
            );
        }

        let bundle = bundle_staging_path(staging, &transfer_id);
        assert!(bundle.file_name().expect("a file name").len() <= MAX_STAGED_NAME_BYTES,);
    }

    /// The identity is compared, never parsed, so no component's own content
    /// may make two different identities render the same. A separator can be
    /// forged — `agent_type` carries a repo-supplied agent name — and encoding
    /// is what removes the question.
    #[test]
    fn a_component_cannot_forge_a_matching_plan_identity() {
        // Shifting a separator across the boundary used to collide these.
        assert_ne!(
            session_plan_identity(Some("a"), Some("b c"), Some("d"), Some("e")),
            session_plan_identity(Some("a"), Some("b"), Some("c d"), Some("e")),
        );
        assert_ne!(
            session_plan_identity(Some("a"), None, Some("b"), None),
            session_plan_identity(Some("a"), Some(""), Some("b"), Some("")),
            "an absent component must not read as an empty one",
        );
        // The same task still matches itself, which is what the caller relies
        // on to decide whether to re-plan after the agent shut down.
        assert_eq!(
            session_plan_identity(Some("s"), Some("claude"), Some("pty"), Some("task-1")),
            session_plan_identity(Some("s"), Some("claude"), Some("pty"), Some("task-1")),
        );
        // And it stays a text file: no control characters in the value.
        let identity = session_plan_identity(Some("s"), Some("claude"), Some("pty"), Some("t"));
        assert!(!identity.chars().any(char::is_control), "{identity}");
    }

    /// A Codex rollout is content-addressed, so an occupied destination is this
    /// transfer's own earlier write rather than a stranger's session.
    ///
    /// `~/.codex/sessions/<Y>/<M>/<D>/rollout-<timestamp>-<session-id>.jsonl`
    /// carries both the session id and the moment it was opened, and the
    /// receiver derives the whole path from the artifact contract — nothing
    /// else can land there. Requiring a write would abandon the conversation on
    /// every retry, because `materialize_transfer_artifact_at_home` reports
    /// `false` for a destination that already exists, which is precisely what
    /// attempt 1 leaves behind.
    #[test]
    fn a_codex_rollout_keeps_its_resume_when_the_destination_is_already_written() {
        let rollout = TransferArtifactPayload {
            artifact_id: "rollout".to_string(),
            filename: "rollout-2026-08-07T10-11-12-364643cc-5e6d-48fc-86ca-ca7764380900.jsonl"
                .to_string(),
            provider: "codex".to_string(),
            kind: TransferArtifactKind::SessionRollout,
            home_rel_path: ".codex/sessions/2026/08/07/rollout.jsonl".to_string(),
            materialization: TransferArtifactMaterialization::CopyFile,
        };

        // Attempt 1 wrote it.
        assert!(resume_survives_existing_destination(
            std::slice::from_ref(&rollout),
            &[("rollout".to_string(), true)],
        ));
        // Attempt 2 finds it already there. That is the same conversation, and
        // abandoning the resume here is the retry regression.
        assert!(resume_survives_existing_destination(
            std::slice::from_ref(&rollout),
            &[("rollout".to_string(), false)],
        ));
        // Even with nothing reported, the path is one only this transfer's
        // artifact can occupy.
        assert!(resume_survives_existing_destination(
            std::slice::from_ref(&rollout),
            &[],
        ));
    }

    /// The counterpart, stated as the rule rather than per provider: only the
    /// kinds landing in a namespace the receiver may already own with
    /// *different* content require a write.
    #[test]
    fn only_shared_namespace_destinations_require_a_write() {
        for (kind, survives_without_a_write) in [
            (TransferArtifactKind::SessionTranscript, true),
            (TransferArtifactKind::SessionRollout, true),
            (TransferArtifactKind::SessionArchive, false),
            (TransferArtifactKind::SessionExport, false),
        ] {
            let only = [artifact(kind, "only")];
            assert_eq!(
                resume_survives_existing_destination(&only, &[("only".to_string(), false)]),
                survives_without_a_write,
                "{kind:?} disagreed about an occupied destination",
            );
            assert!(
                resume_survives_existing_destination(&only, &[("only".to_string(), true)]),
                "{kind:?} abandoned a resume it had just written",
            );
        }
    }

    /// The export is the whole artifact list — there is no file to copy and no
    /// directory to archive alongside it.
    #[test]
    fn an_opencode_plan_stages_one_export_artifact_under_its_contract() {
        let plan = SessionArtifactPlan {
            session_id: "ses_02645d9aaffeeOgwt2rbXIcTdp".to_string(),
            provider: "opencode".to_string(),
            archive: None,
            files: Vec::new(),
            opencode_export: Some(PathBuf::from("/does/not/matter")),
        };
        // Staging shells out to `opencode export`; without the CLI it fails,
        // and with it the single artifact is fully determined. Either way the
        // contract the payload validator enforces is what is asserted here.
        let temp = tempfile::tempdir().expect("staging");
        match stage_plan(&plan, "transfer-1", temp.path()) {
            Ok(staged) => {
                assert_eq!(staged.len(), 1);
                assert_eq!(staged[0].payload.kind, TransferArtifactKind::SessionExport);
                assert_eq!(
                    staged[0].payload.materialization,
                    TransferArtifactMaterialization::OpencodeImport
                );
                assert_eq!(staged[0].payload.filename, OPENCODE_SESSION_EXPORT_FILENAME);
                assert_eq!(
                    staged[0].payload.home_rel_path,
                    OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH
                );
                // Owned: the export is a temp file this transfer made, unlike a
                // live transcript, so the sidecar deletes it with the transfer.
                assert!(staged[0].owned);
            }
            Err(error) => assert!(error.contains("opencode"), "{error}"),
        }
    }

    /// An export that shipped is a conversation that shipped, exactly as a
    /// transcript is — it must not be vetoed by an archive that was not written.
    #[test]
    fn an_export_decides_the_resume_the_way_a_transcript_does() {
        let export = TransferArtifactPayload {
            artifact_id: "export".to_string(),
            filename: OPENCODE_SESSION_EXPORT_FILENAME.to_string(),
            provider: "opencode".to_string(),
            kind: TransferArtifactKind::SessionExport,
            home_rel_path: OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH.to_string(),
            materialization: TransferArtifactMaterialization::OpencodeImport,
        };
        assert!(resume_survives_existing_destination(
            std::slice::from_ref(&export),
            &[("export".to_string(), true)],
        ));
        assert!(resume_survives_existing_destination(
            &[
                artifact(TransferArtifactKind::SessionArchive, "archive"),
                export.clone(),
            ],
            &[("archive".to_string(), false), ("export".to_string(), true)],
        ));

        // An export that did not land is a destination this machine already
        // owns. `opencode import` does not replace a session id it holds — it
        // re-keys the existing one — so resuming anyway would attach this task
        // to an unrelated local conversation and drop the shipped one.
        assert!(!resume_survives_existing_destination(
            std::slice::from_ref(&export),
            &[("export".to_string(), false)],
        ));
        // And an export nobody reported on is not evidence that it landed.
        assert!(!resume_survives_existing_destination(
            std::slice::from_ref(&export),
            &[],
        ));
    }

    #[test]
    fn a_codex_rollout_is_located_by_scanning_its_date_partitioned_directory() {
        let home = tempfile::tempdir().expect("home");
        let session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";
        let day = home.path().join(".codex/sessions/2026/08/07");
        std::fs::create_dir_all(&day).expect("day dir");
        let filename = format!("rollout-2026-08-07T10-11-12-{session_id}.jsonl");
        std::fs::write(day.join(&filename), b"{}").expect("rollout");

        let plan = plan_session_artifacts(
            home.path(),
            Some(session_id),
            Some("codex"),
            Some("pty"),
            None,
            "task-1",
        )
        .expect("located")
        .expect("a rollout to ship");
        assert_eq!(plan.files.len(), 1);
        assert_eq!(
            plan.files[0].home_rel_path,
            format!(".codex/sessions/2026/08/07/{filename}")
        );
    }
}
