//! The transfer engine's durable work queue.
//!
//! The four state-mutating sidecar lifecycle events used to be delivered to a
//! renderer window from an in-memory Tauri queue. Only `transfer-request`
//! survived an app restart, via sidecar replay plus a DB sweep; the other three
//! simply died with the process. They are rows here instead, appended by the
//! same reader that observes the event, so a restart resumes them rather than
//! orphaning them.
//!
//! `id` is derived from the event rather than generated, which is what makes a
//! redelivered event collapse onto the work already queued. That is the durable
//! replacement for the sidecar's in-memory `claimed_phases` idempotency: what
//! used to be at-least-once delivery to a window is exactly-once execution in
//! one process.

use super::Db;
use rusqlite::OptionalExtension;

/// Backoff for a work item whose attempt failed. Bounded so a permanently
/// broken item does not spin, and short enough that a transient peer outage
/// resolves without operator action.
const RETRY_BACKOFF_SECONDS: [i64; 5] = [1, 5, 30, 120, 600];

/// Attempts before an item is parked as `failed`. A transfer that cannot make
/// progress has to become visible rather than retry silently forever.
pub const MAX_TRANSFER_WORK_ATTEMPTS: i64 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferWorkItem {
    pub id: String,
    pub kind: String,
    pub transfer_id: Option<String>,
    pub payload_json: String,
    pub attempts: i64,
}

fn read_work_item(row: &rusqlite::Row<'_>) -> Result<TransferWorkItem, rusqlite::Error> {
    Ok(TransferWorkItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        transfer_id: row.get(2)?,
        payload_json: row.get(3)?,
        attempts: row.get(4)?,
    })
}

impl Db {
    /// Appends work, or does nothing if this exact work is already queued.
    ///
    /// Returns whether a new row was created, so the caller can tell a fresh
    /// event from a redelivery without a second read.
    pub fn enqueue_transfer_work(
        &self,
        id: &str,
        kind: &str,
        transfer_id: Option<&str>,
        payload_json: &str,
    ) -> Result<bool, rusqlite::Error> {
        let inserted = self.conn.execute(
            "INSERT INTO transfer_work (id, kind, transfer_id, payload_json)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING",
            (id, kind, transfer_id, payload_json),
        )?;
        Ok(inserted == 1)
    }

    /// Takes the next runnable item, marking it `running` in the same statement
    /// so two drains cannot claim it. Ordering is by `run_after` then insertion
    /// order, which preserves lifecycle order among items that are all ready.
    pub fn claim_next_transfer_work(&self) -> Result<Option<TransferWorkItem>, rusqlite::Error> {
        let claimed = self
            .conn
            .query_row(
                "UPDATE transfer_work
                 SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
                 WHERE id = (
                     SELECT id FROM transfer_work
                     WHERE status = 'pending' AND run_after <= datetime('now')
                     ORDER BY run_after, created_at, id
                     LIMIT 1
                 )
                 RETURNING id, kind, transfer_id, payload_json, attempts",
                [],
                read_work_item,
            )
            .optional()?;
        Ok(claimed)
    }

    /// The soonest a parked item becomes runnable, so a drain loop can sleep
    /// until then instead of polling.
    pub fn next_transfer_work_delay_seconds(&self) -> Result<Option<i64>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT MAX(0, CAST(strftime('%s', MIN(run_after)) AS INTEGER)
                               - CAST(strftime('%s', 'now') AS INTEGER))
                 FROM transfer_work
                 WHERE status = 'pending'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    pub fn complete_transfer_work(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE transfer_work
             SET status = 'done', error = NULL, updated_at = datetime('now')
             WHERE id = ?",
            [id],
        )?;
        Ok(())
    }

    /// Records a failed attempt. Returns `true` while the item is still
    /// retriable; once the attempt budget is spent it is parked as `failed` so
    /// the transfer's own failure path can report it instead of the queue
    /// retrying an unrecoverable step forever.
    pub fn fail_transfer_work_attempt(
        &self,
        id: &str,
        attempts: i64,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        if attempts >= MAX_TRANSFER_WORK_ATTEMPTS {
            self.conn.execute(
                "UPDATE transfer_work
                 SET status = 'failed', error = ?, updated_at = datetime('now')
                 WHERE id = ?",
                (reason, id),
            )?;
            return Ok(false);
        }
        let backoff = RETRY_BACKOFF_SECONDS
            [(attempts.max(1) as usize - 1).min(RETRY_BACKOFF_SECONDS.len() - 1)];
        self.conn.execute(
            "UPDATE transfer_work
             SET status = 'pending',
                 error = ?,
                 updated_at = datetime('now'),
                 run_after = datetime('now', ?)
             WHERE id = ?",
            (reason, format!("+{backoff} seconds"), id),
        )?;
        Ok(true)
    }

    /// Returns pending work whose in-process run was interrupted — a server or
    /// app restart — to `pending`. Called once at engine start; without it a
    /// `running` row would sit claimed by a process that no longer exists.
    pub fn requeue_interrupted_transfer_work(&self) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "UPDATE transfer_work
             SET status = 'pending', run_after = datetime('now'), updated_at = datetime('now')
             WHERE status = 'running'",
            [],
        )
    }

    /// Claims a step that must run at most once for this work item, even across
    /// a restart that resumes it. Returns `true` for the claimer and `false`
    /// for everyone after — the durable form of the sidecar's in-memory
    /// `claimed_phases`.
    ///
    /// The claim is taken *before* the effect, so a crash between the two
    /// leaves it held and the resumed item skips the effect. That is the
    /// at-most-once guarantee this exists for. A caller whose effect *failed*
    /// must release it with [`Self::release_transfer_work_phase`], or the retry
    /// will skip a step that never happened.
    pub fn claim_transfer_work_phase(
        &self,
        work_id: &str,
        phase: &str,
    ) -> Result<bool, rusqlite::Error> {
        let inserted = self.conn.execute(
            "INSERT INTO transfer_work_phase (work_id, phase) VALUES (?, ?)
             ON CONFLICT(work_id, phase) DO NOTHING",
            (work_id, phase),
        )?;
        Ok(inserted == 1)
    }

    /// Gives a claim back after the effect it guarded failed.
    ///
    /// Without this, a transient failure — a daemon that was not connectable,
    /// a peer that did not answer — is indistinguishable from a completed step
    /// on the retry: the claim returns `false`, the effect is skipped, and the
    /// work item goes on to report success for something it never did.
    pub fn release_transfer_work_phase(
        &self,
        work_id: &str,
        phase: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM transfer_work_phase WHERE work_id = ? AND phase = ?",
            (work_id, phase),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn transfer_work_status(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT status FROM transfer_work WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(suffix: &str) -> Db {
        Db::open_for_tests(&Db::test_db_path(suffix)).expect("test db")
    }

    /// The property the in-memory Tauri queue never had: work whose process
    /// died mid-flight is still there, still runnable, and runs exactly once.
    #[test]
    fn work_interrupted_by_a_restart_resumes_instead_of_orphaning() {
        let db = open("transfer-work-restart");
        assert!(db
            .enqueue_transfer_work("finalize:t-1", "finalize", Some("t-1"), "{}")
            .expect("enqueue"));

        let claimed = db.claim_next_transfer_work().expect("claim").expect("work");
        assert_eq!(claimed.id, "finalize:t-1");
        assert_eq!(claimed.attempts, 1);
        assert!(
            db.claim_next_transfer_work()
                .expect("second claim")
                .is_none(),
            "a claimed item must not be handed to a second drain",
        );

        // The process dies here — nothing marks the item done or failed.
        assert_eq!(
            db.transfer_work_status("finalize:t-1").expect("status"),
            Some("running".to_string()),
        );
        assert_eq!(
            db.requeue_interrupted_transfer_work().expect("requeue"),
            1,
            "a restart must return in-flight work to the queue",
        );
        let resumed = db.claim_next_transfer_work().expect("claim").expect("work");
        assert_eq!(resumed.id, "finalize:t-1");
        assert_eq!(resumed.attempts, 2);

        db.complete_transfer_work("finalize:t-1").expect("complete");
        assert!(
            db.claim_next_transfer_work().expect("drained").is_none(),
            "completed work must not be handed out again",
        );
    }

    /// A redelivered sidecar event derives the same work id, so it collapses
    /// onto the work already queued rather than scheduling the step twice. This
    /// is the durable replacement for the sidecar's in-memory `claimed_phases`.
    #[test]
    fn a_redelivered_event_collapses_onto_the_work_already_queued() {
        let db = open("transfer-work-redelivery");
        assert!(db
            .enqueue_transfer_work("committed:t-1", "outgoing-committed", Some("t-1"), "{}")
            .expect("first"));
        assert!(
            !db.enqueue_transfer_work("committed:t-1", "outgoing-committed", Some("t-1"), "{}")
                .expect("redelivery"),
            "a redelivered event scheduled a second execution",
        );
        assert!(db.claim_next_transfer_work().expect("claim").is_some());
        assert!(db.claim_next_transfer_work().expect("only one").is_none());

        // Even after the work has run, the same event must not re-run it.
        db.complete_transfer_work("committed:t-1")
            .expect("complete");
        assert!(!db
            .enqueue_transfer_work("committed:t-1", "outgoing-committed", Some("t-1"), "{}")
            .expect("post-completion redelivery"),);
        assert!(db
            .claim_next_transfer_work()
            .expect("still drained")
            .is_none());
    }

    /// A retry must not repeat the step that already happened — signalling the
    /// source agent, closing the source task — even across a restart that
    /// resumes the same work item.
    #[test]
    fn a_single_flight_phase_is_claimed_once_across_retries() {
        let db = open("transfer-work-phase");
        db.enqueue_transfer_work("finalize:t-1", "finalize", Some("t-1"), "{}")
            .expect("enqueue");
        assert!(db
            .claim_transfer_work_phase("finalize:t-1", "pty-finalization-signal")
            .expect("first claim"));
        assert!(
            !db.claim_transfer_work_phase("finalize:t-1", "pty-finalization-signal")
                .expect("second claim"),
            "a retry re-ran a single-flight phase",
        );
        // A different phase, and a different work item, are unaffected.
        assert!(db
            .claim_transfer_work_phase("finalize:t-1", "acknowledge-import")
            .expect("other phase"));
        db.enqueue_transfer_work("finalize:t-2", "finalize", Some("t-2"), "{}")
            .expect("enqueue");
        assert!(db
            .claim_transfer_work_phase("finalize:t-2", "pty-finalization-signal")
            .expect("other work"));
    }

    /// A claim taken for an effect that then failed has to come back, or the
    /// retry skips a step that never happened and the work item goes on to
    /// report success for it.
    #[test]
    fn a_released_phase_is_reclaimable_by_the_retry() {
        let db = open("transfer-work-phase-release");
        db.enqueue_transfer_work("import:t-1", "import", Some("t-1"), "{}")
            .expect("enqueue");

        assert!(db
            .claim_transfer_work_phase("import:t-1", "acknowledge-import")
            .expect("first claim"));
        // The effect failed, so the attempt is given back.
        db.release_transfer_work_phase("import:t-1", "acknowledge-import")
            .expect("release");
        assert!(
            db.claim_transfer_work_phase("import:t-1", "acknowledge-import")
                .expect("retry claim"),
            "the retry could not re-attempt an effect that never happened",
        );

        // Once it succeeds and the claim is kept, it stays taken.
        assert!(!db
            .claim_transfer_work_phase("import:t-1", "acknowledge-import")
            .expect("third claim"));

        // Releasing a phase that was never claimed is not an error — a caller
        // unwinding a failure should not have to know which claims it holds.
        db.release_transfer_work_phase("import:t-1", "never-claimed")
            .expect("release unclaimed");
        db.release_transfer_work_phase("import:unknown", "acknowledge-import")
            .expect("release for unknown work");
        // And releasing one phase leaves the others alone.
        assert!(db
            .claim_transfer_work_phase("import:t-1", "other-phase")
            .expect("other phase"));
        db.release_transfer_work_phase("import:t-1", "other-phase")
            .expect("release other");
        assert!(!db
            .claim_transfer_work_phase("import:t-1", "acknowledge-import")
            .expect("unrelated release must not free this one"));
    }

    /// Retries are bounded. A transfer that can make no further progress has to
    /// become visible instead of retrying behind the operator's back forever.
    #[test]
    fn a_failing_item_backs_off_and_is_eventually_parked() {
        let db = open("transfer-work-backoff");
        db.enqueue_transfer_work("push:t-1", "push", None, "{}")
            .expect("enqueue");
        for attempt in 1..MAX_TRANSFER_WORK_ATTEMPTS {
            assert!(
                db.fail_transfer_work_attempt("push:t-1", attempt, "peer unreachable")
                    .expect("retriable"),
                "attempt {attempt} should still be retriable",
            );
            assert_eq!(
                db.transfer_work_status("push:t-1").expect("status"),
                Some("pending".to_string()),
            );
            // The backoff is what stops a broken item spinning; it also means
            // the item is not immediately claimable again.
            assert!(db.claim_next_transfer_work().expect("claim").is_none());
            assert!(db
                .next_transfer_work_delay_seconds()
                .expect("delay")
                .is_some_and(|delay| delay > 0));
        }
        assert!(
            !db.fail_transfer_work_attempt(
                "push:t-1",
                MAX_TRANSFER_WORK_ATTEMPTS,
                "peer unreachable"
            )
            .expect("exhausted"),
            "the attempt budget must run out rather than retry forever",
        );
        assert_eq!(
            db.transfer_work_status("push:t-1").expect("status"),
            Some("failed".to_string()),
        );
    }
}
