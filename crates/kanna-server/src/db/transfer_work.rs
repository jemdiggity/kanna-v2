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

/// The `AND` clause that hides a transfer's rows while the caller is running one
/// of them. Empty for an empty list, so the ordinary statement carries no
/// parameters at all.
fn busy_transfer_exclusion(busy_transfer_ids: &[String]) -> String {
    if busy_transfer_ids.is_empty() {
        return String::new();
    }
    let placeholders = vec!["?"; busy_transfer_ids.len()].join(", ");
    format!(" AND (transfer_id IS NULL OR transfer_id NOT IN ({placeholders}))")
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
    ///
    /// `busy_transfer_ids` are transfers the caller already has work in flight
    /// for, and their rows are passed over rather than claimed. The engine runs
    /// items concurrently, and one transfer's items are a *sequence* — its
    /// finalization must answer the peer before the commit receipt closes the
    /// source task — so concurrency is only ever across transfers. Skipping in
    /// the claim rather than after it is what keeps a deferral from spending an
    /// attempt: a row this call passes over is untouched, still `pending`, with
    /// its `attempts` and `run_after` intact.
    pub fn claim_next_transfer_work(
        &self,
        busy_transfer_ids: &[String],
    ) -> Result<Option<TransferWorkItem>, rusqlite::Error> {
        self.claim_next_transfer_work_at(busy_transfer_ids, "now")
    }

    fn claim_next_transfer_work_at(
        &self,
        busy_transfer_ids: &[String],
        now: &str,
    ) -> Result<Option<TransferWorkItem>, rusqlite::Error> {
        // Work with no transfer id — a push, before anything has reserved one —
        // has no sequence to preserve and is never excluded. Two pushes of one
        // task are not held apart here either: they are already held apart
        // transactionally, by the eligibility read in `push::run_push` over
        // `idx_task_transfer_active_outgoing_source`, which is what a renderer
        // snapshot could not do.
        let claimed = self
            .conn
            .query_row(
                &format!(
                    "UPDATE transfer_work
                     SET status = 'running', attempts = attempts + 1, updated_at = datetime(?)
                     WHERE id = (
                         SELECT id FROM transfer_work
                         WHERE status = 'pending' AND run_after <= datetime(?){}
                         ORDER BY run_after, created_at, id
                         LIMIT 1
                     )
                     RETURNING id, kind, transfer_id, payload_json, attempts",
                    busy_transfer_exclusion(busy_transfer_ids),
                ),
                rusqlite::params_from_iter(
                    [now, now]
                        .into_iter()
                        .chain(busy_transfer_ids.iter().map(String::as_str)),
                ),
                read_work_item,
            )
            .optional()?;
        Ok(claimed)
    }

    /// The soonest a parked item becomes runnable, so a drain loop can sleep
    /// until then instead of polling.
    ///
    /// Takes the same exclusion as [`Self::claim_next_transfer_work`], and for
    /// the same reason read the other way round: a caller that slept on a delay
    /// computed over rows it cannot claim would wake immediately and spin until
    /// the transfer holding them finished.
    pub fn next_transfer_work_delay_seconds(
        &self,
        busy_transfer_ids: &[String],
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.next_transfer_work_delay_seconds_at(busy_transfer_ids, "now")
    }

    fn next_transfer_work_delay_seconds_at(
        &self,
        busy_transfer_ids: &[String],
        now: &str,
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.conn
            .query_row(
                &format!(
                    "SELECT MAX(0, CAST(strftime('%s', MIN(run_after)) AS INTEGER)
                                   - CAST(strftime('%s', ?) AS INTEGER))
                     FROM transfer_work
                     WHERE status = 'pending'{}",
                    busy_transfer_exclusion(busy_transfer_ids),
                ),
                rusqlite::params_from_iter(
                    std::iter::once(now).chain(busy_transfer_ids.iter().map(String::as_str)),
                ),
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
        self.fail_transfer_work_attempt_at(id, attempts, reason, "now")
    }

    fn fail_transfer_work_attempt_at(
        &self,
        id: &str,
        attempts: i64,
        reason: &str,
        now: &str,
    ) -> Result<bool, rusqlite::Error> {
        if attempts >= MAX_TRANSFER_WORK_ATTEMPTS {
            self.conn.execute(
                "UPDATE transfer_work
                 SET status = 'failed', error = ?, updated_at = datetime(?)
                 WHERE id = ?",
                (reason, now, id),
            )?;
            return Ok(false);
        }
        let backoff = RETRY_BACKOFF_SECONDS
            [(attempts.max(1) as usize - 1).min(RETRY_BACKOFF_SECONDS.len() - 1)];
        self.conn.execute(
            "UPDATE transfer_work
             SET status = 'pending',
                 error = ?,
                 updated_at = datetime(?),
                 run_after = datetime(?, ?)
             WHERE id = ?",
            (reason, now, now, format!("+{backoff} seconds"), id),
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

    /// Records what a step observed, once, and returns what the winner
    /// recorded.
    ///
    /// [`Self::claim_transfer_work_phase`] answers "has this run?"; this
    /// answers "what did it decide?" — and the difference matters wherever a
    /// retry would otherwise recompute an answer against a machine the first
    /// attempt already changed. The source's session *before* its agent was
    /// signalled cannot be re-observed once the agent is dead, and an import's
    /// materialization cannot be re-observed once the session is installed.
    /// Both would silently answer "nothing there" on attempt 2.
    ///
    /// First writer wins and every later caller reads that value, so the
    /// observation a transfer acts on is the same one on every attempt.
    /// `None` records "observed, and the answer was nothing", which is
    /// deliberately distinct from never having observed.
    pub fn record_transfer_work_observation(
        &self,
        work_id: &str,
        phase: &str,
        value: Option<&str>,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO transfer_work_phase (work_id, phase, value) VALUES (?, ?, ?)
             ON CONFLICT(work_id, phase) DO NOTHING",
            (work_id, phase, value),
        )?;
        self.read_transfer_work_observation(work_id, phase)
            .map(|observed| observed.flatten())
    }

    /// What a step recorded, or `None` if it has never run. The outer option
    /// distinguishes "never observed" from "observed nothing".
    pub fn read_transfer_work_observation(
        &self,
        work_id: &str,
        phase: &str,
    ) -> Result<Option<Option<String>>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT value FROM transfer_work_phase WHERE work_id = ? AND phase = ?",
                (work_id, phase),
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
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

        let claimed = db
            .claim_next_transfer_work(&[])
            .expect("claim")
            .expect("work");
        assert_eq!(claimed.id, "finalize:t-1");
        assert_eq!(claimed.attempts, 1);
        assert!(
            db.claim_next_transfer_work(&[])
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
        let resumed = db
            .claim_next_transfer_work(&[])
            .expect("claim")
            .expect("work");
        assert_eq!(resumed.id, "finalize:t-1");
        assert_eq!(resumed.attempts, 2);

        db.complete_transfer_work("finalize:t-1").expect("complete");
        assert!(
            db.claim_next_transfer_work(&[]).expect("drained").is_none(),
            "completed work must not be handed out again",
        );
    }

    /// A transfer whose work is in flight is skipped over, not claimed — and
    /// skipping costs it nothing.
    ///
    /// The engine runs items concurrently, so this is what keeps one transfer's
    /// items in order while another transfer's proceed. Returning the row and
    /// deferring it would be worse than useless: the claim increments `attempts`,
    /// so a transfer whose finalization ran long would burn its retry budget on
    /// deferrals of the item waiting behind it.
    #[test]
    fn a_transfer_already_in_flight_is_passed_over_without_spending_an_attempt() {
        let db = open("transfer-work-busy");
        db.enqueue_transfer_work("finalize:t-1", "finalize", Some("t-1"), "{}")
            .expect("enqueue");
        db.enqueue_transfer_work("committed:t-1", "outgoing-committed", Some("t-1"), "{}")
            .expect("enqueue");
        db.enqueue_transfer_work("import:t-2", "import", Some("t-2"), "{}")
            .expect("enqueue");
        db.enqueue_transfer_work("pull:sidecar-a:1", "push", None, "{}")
            .expect("enqueue");

        let first = db
            .claim_next_transfer_work(&[])
            .expect("claim")
            .expect("work");
        assert_eq!(
            first.transfer_id.as_deref(),
            Some("t-1"),
            "both of t-1's rows sort ahead of the others",
        );

        // t-1 is in flight: its second item is invisible, while the unrelated
        // transfer and the transfer-less push are handed out immediately.
        let busy = vec!["t-1".to_string()];
        let next = db
            .claim_next_transfer_work(&busy)
            .expect("claim")
            .expect("an unrelated transfer was blocked behind t-1");
        assert_eq!(next.id, "import:t-2");
        let pushed = db
            .claim_next_transfer_work(&busy)
            .expect("claim")
            .expect("a transfer-less push was blocked behind t-1");
        assert_eq!(pushed.id, "pull:sidecar-a:1");
        assert!(
            db.claim_next_transfer_work(&busy).expect("claim").is_none(),
            "a second item of an in-flight transfer was claimed",
        );
        // …and nothing runnable is left to sleep on, so the drain parks on the
        // worker instead of spinning against a row it cannot take.
        assert_eq!(
            db.next_transfer_work_delay_seconds(&busy).expect("delay"),
            None,
        );

        // Once t-1's item is settled its next one is claimable, still on its
        // first attempt.
        db.complete_transfer_work(&first.id).expect("complete");
        let resumed = db
            .claim_next_transfer_work(&[])
            .expect("claim")
            .expect("t-1's second item never became claimable");
        assert_eq!(resumed.transfer_id.as_deref(), Some("t-1"));
        assert_ne!(resumed.id, first.id);
        assert_eq!(
            resumed.attempts, 1,
            "being passed over spent an attempt from the retry budget",
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
        assert!(db.claim_next_transfer_work(&[]).expect("claim").is_some());
        assert!(db
            .claim_next_transfer_work(&[])
            .expect("only one")
            .is_none());

        // Even after the work has run, the same event must not re-run it.
        db.complete_transfer_work("committed:t-1")
            .expect("complete");
        assert!(!db
            .enqueue_transfer_work("committed:t-1", "outgoing-committed", Some("t-1"), "{}")
            .expect("post-completion redelivery"),);
        assert!(db
            .claim_next_transfer_work(&[])
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

    /// An observation is taken once and read back by every retry.
    ///
    /// Two steps cannot be re-observed: the source's session *before* its agent
    /// was signalled (attempt 2 looks at a dead agent) and an import's
    /// materialization (attempt 2 looks at destinations attempt 1 wrote). Both
    /// would quietly answer "nothing there".
    #[test]
    fn an_observation_is_taken_once_and_every_retry_reads_the_winner() {
        let db = open("transfer-work-observation");
        db.enqueue_transfer_work("finalize:t-1", "finalize", Some("t-1"), "{}")
            .expect("enqueue");

        assert_eq!(
            db.read_transfer_work_observation("finalize:t-1", "session-before-signal")
                .expect("read"),
            None,
            "an unobserved phase must be distinguishable from one that saw nothing",
        );

        assert_eq!(
            db.record_transfer_work_observation(
                "finalize:t-1",
                "session-before-signal",
                Some("ses_live"),
            )
            .expect("first observation"),
            Some("ses_live".to_string()),
        );
        // The retry looks at a dead agent and sees nothing — and is told what
        // the live observation found.
        assert_eq!(
            db.record_transfer_work_observation("finalize:t-1", "session-before-signal", None)
                .expect("retry observation"),
            Some("ses_live".to_string()),
            "a retry overwrote the only observation taken against a live agent",
        );
        assert_eq!(
            db.read_transfer_work_observation("finalize:t-1", "session-before-signal")
                .expect("read back"),
            Some(Some("ses_live".to_string())),
        );
    }

    /// "Observed, and the answer was nothing" is a real answer, and has to be
    /// told apart from "never observed" — otherwise an import that deliberately
    /// abandoned its resume re-runs the whole materialization on every retry.
    #[test]
    fn observing_nothing_is_recorded_as_an_answer_rather_than_as_silence() {
        let db = open("transfer-work-observation-none");
        db.enqueue_transfer_work("import:t-1", "import", Some("t-1"), "{}")
            .expect("enqueue");

        assert_eq!(
            db.record_transfer_work_observation("import:t-1", "materialize-resume-state", None)
                .expect("observe nothing"),
            None,
        );
        assert_eq!(
            db.read_transfer_work_observation("import:t-1", "materialize-resume-state")
                .expect("read"),
            Some(None),
            "an observed absence must not read as never-observed",
        );
        // And a later attempt cannot talk the transfer back into a resume.
        assert_eq!(
            db.record_transfer_work_observation(
                "import:t-1",
                "materialize-resume-state",
                Some("ses_late"),
            )
            .expect("retry"),
            None,
        );
    }

    /// The value primitive shares its table with the boolean claim, so neither
    /// may quietly answer for the other.
    #[test]
    fn observations_and_claims_do_not_answer_for_each_other() {
        let db = open("transfer-work-observation-claim");
        db.enqueue_transfer_work("finalize:t-1", "finalize", Some("t-1"), "{}")
            .expect("enqueue");

        // A claim taken first leaves no value, and the observation that follows
        // reads that absence rather than inventing one.
        assert!(db
            .claim_transfer_work_phase("finalize:t-1", "pty-finalization-signal")
            .expect("claim"));
        assert_eq!(
            db.read_transfer_work_observation("finalize:t-1", "pty-finalization-signal")
                .expect("read"),
            Some(None),
        );
        // An observation occupies the phase, so a claim on it reports "already
        // taken" — they are the same at-most-once slot by design.
        db.record_transfer_work_observation("finalize:t-1", "session-before-signal", Some("x"))
            .expect("observe");
        assert!(!db
            .claim_transfer_work_phase("finalize:t-1", "session-before-signal")
            .expect("claim over observation"),);
    }

    /// Retries are bounded. A transfer that can make no further progress has to
    /// become visible instead of retrying behind the operator's back forever.
    #[test]
    fn a_failing_item_backs_off_and_is_eventually_parked() {
        let db = open("transfer-work-backoff");
        let controlled_now = "2026-09-03 12:00:00";
        db.enqueue_transfer_work("push:t-1", "push", None, "{}")
            .expect("enqueue");
        for attempt in 1..MAX_TRANSFER_WORK_ATTEMPTS {
            assert!(
                db.fail_transfer_work_attempt_at(
                    "push:t-1",
                    attempt,
                    "peer unreachable",
                    controlled_now,
                )
                .expect("retriable"),
                "attempt {attempt} should still be retriable",
            );
            assert_eq!(
                db.transfer_work_status("push:t-1").expect("status"),
                Some("pending".to_string()),
            );
            // The backoff is what stops a broken item spinning; it also means
            // the item is not immediately claimable again.
            assert!(db
                .claim_next_transfer_work_at(&[], controlled_now)
                .expect("claim")
                .is_none());
            let expected_backoff =
                RETRY_BACKOFF_SECONDS[(attempt as usize - 1).min(RETRY_BACKOFF_SECONDS.len() - 1)];
            assert_eq!(
                db.next_transfer_work_delay_seconds_at(&[], controlled_now)
                    .expect("delay"),
                Some(expected_backoff),
            );
        }
        assert!(
            !db.fail_transfer_work_attempt_at(
                "push:t-1",
                MAX_TRANSFER_WORK_ATTEMPTS,
                "peer unreachable",
                controlled_now,
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
