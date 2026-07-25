# Remote Task Read Dwell Review Hardening Design

## Goal

Close the remaining trust, identity, and upgrade-path gaps in remote task read
dwell without changing the owner-bound compare-and-swap behavior.

## Trusted LAN Snapshot Identity

`TransferRuntime::list_peer_task_snapshots` queries only discovered peers whose
public key matches an active pairing record. The queried discovery entry is the
trusted endpoint identity. A `TaskSnapshot` response must carry the same
`peer_id`; a mismatch is a protocol violation.

Reject a mismatched response and continue listing other trusted peers. Do not
return its snapshot and do not substitute the response-carried identity into a
`PeerTaskSnapshot`. This prevents a paired peer from advertising another
peer's identity and causing later terminal or mark-read actions to route to the
wrong owner.

## Collision-Free LAN Presentation Identity

The canonical snapshot publisher intentionally omits `cloudTaskId`, so the LAN
index must not use that optional field as identity input. For every accepted
task, derive the presentation identity from:

1. the trusted peer ID supplied by task-transfer;
2. the publisher's stable local repository ID, falling back to its repository
   snapshot ID for compatible older payloads; and
3. the publisher's owner-local task ID.

Encode the three values as a structured tuple rather than delimiter-joining
raw strings. Prefix that encoded tuple with the LAN namespace and pass it as
the mapped task ID. The mapped item, terminal reference, owner ID, and activity
revision then remain paired to the same source task even when one peer
publishes several tasks or raw identifiers contain delimiters.

## Safe Migration 029

Replace the permissive column-add helper with a fallible helper. It first
queries SQLite column metadata for the exact table and column. If the column
already exists, it returns success without issuing `ALTER TABLE`. Otherwise it
executes `ALTER TABLE ... ADD COLUMN` and propagates any error.

Every migration call site propagates the helper result through
`run_migration`. Therefore an unexpected add-column failure rolls back the
transaction, does not record the migration ID, and is retried on a later
startup. Existing columns remain idempotent.

## Upgrade Compatibility

Exercise migration 029 against a database shaped like `origin/main`: its
`pipeline_item` table has no `activity_revision`, contains an existing task,
and its `schema_migrations` table records every migration through 028.
Opening it through `Db::open_migrated` must:

- add `activity_revision` as `INTEGER NOT NULL DEFAULT 0`;
- backfill the existing task with zero;
- load the task through `get_pipeline_item`;
- expose the same revision through the desktop UI snapshot;
- reopen without error and retain exactly one migration-029 record; and
- increment the revision when the task changes activity.

The package-level initial-schema expectation remains the fresh-install
counterpart and must continue asserting the same column definition.

## Tests

Use red-green regressions at each boundary:

- a paired test peer returns a snapshot claiming another peer ID, and the
  runtime excludes it;
- a LAN payload with multiple tasks and omitted `cloudTaskId` produces distinct
  item IDs whose terminal references and activity revisions match their owner
  tasks;
- the origin/main-era database upgrade satisfies the schema, backfill, query,
  snapshot, reopen, migration-record, and activity-transition assertions; and
- focused Rust and Vitest suites pass before broader repository checks.
