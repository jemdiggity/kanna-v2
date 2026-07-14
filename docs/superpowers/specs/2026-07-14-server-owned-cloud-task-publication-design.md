# Server-Owned Cloud Task Publication Design

## Goal

Make `kanna-server` the only producer of the desktop's Firestore task index. Vue renderers retain only the signed-in credential association needed to bind the server's stable desktop credential to a Firebase user; all renderer windows otherwise consume cloud data read-only.

## Architecture

`kanna-server` maps its authoritative SQLite UI snapshot into the existing mobile cloud task schema. Its one authenticated relay WebSocket sends a versioned, full open-task reconciliation message. A publisher state machine coalesces rapid SQLite changes to the newest snapshot, allows one request in flight, retries failed or timed-out requests with bounded backoff, and forces a full reconciliation after every authenticated reconnect.

The relay handles the publication message locally instead of routing it to phones. It derives `userId` and `desktopId` from the authenticated connection, revalidates the connection credential before every write, validates and bounds the payload, and uses Firebase Admin to merge the authenticated desktop document and reconcile only that document's `tasks` subcollection. It acknowledges success or a stable error to `kanna-server`. A revoked or reassigned credential fails revalidation and closes the server connection, preventing writes to the old account.

## Snapshot Contract

The message is `{ type: "task_snapshot_publish", id, snapshot }`. `snapshot` contains `schemaVersion: 1`, the desktop display name, and the complete current set of open task documents. Task documents preserve the existing fields: owner/local identities, title and prompt snippet, stage/activity/status, repository identity and remote URL/hash, branch/base/PR metadata, agent provider/type, transfer defaults, blockers, and lifecycle timestamps.

The relay rejects unknown schema versions, mismatched owner desktop IDs, duplicate local task identities, too many tasks, excessive strings/arrays, invalid nested structures, and oversized WebSocket messages. It writes task data supplied by the server but supplies the authoritative owner desktop ID from the connection and Firestore server timestamps for the desktop record.

## Renderer Boundary

The existing direct Firestore task publisher and all calls from `useAppCloudWorkspace`, task creation, close/advance actions, and remote-close cleanup are removed. The auth composable invokes a small credential-association service once per signed-in user. That service writes the deterministic top-level `desktopCredentials/{desktopId}` document with `desktopId`, `desktopSecretHash`, display name, and owning UID, plus the user profile email. It never reads SQLite or writes task documents. Firestore rules allow signed-in clients to read their own `users/{uid}/desktops/*` task index but deny all client writes and deletes there; only the relay's Admin SDK reconciles that subtree.

On sign-out, the still-authenticated owner tombstones its canonical credential document while preserving the unreadable desktop-secret hash. Rules deny deletion and hash rotation. A later signed-in user on the same physical desktop may reclaim the revoked document only by presenting that same locally derived hash, which avoids both a legacy-fallback window and an unauthenticated claim race. The relay revalidates every publication, so an old authenticated socket receives a negative acknowledgement and closes after revocation or reassignment; subsequent publications resolve only to the new owner's subtree.

LAN task discovery remains separate from cloud publication. This change does not make a renderer a Firestore task publisher merely because it refreshes the existing local transfer snapshot.

## Failure Handling

Only one publication is in flight. Newer SQLite states replace the queued state. A negative acknowledgement or timeout schedules a bounded retry; exhausting the retry budget reconnects the relay, which reauthenticates and reconciles from current SQLite state. Successful acknowledgement advances the last-published fingerprint. Disconnect discards in-flight transport state but not the need to reconcile.

Credential revalidation occurs immediately before publication. Revocation, deletion, secret rotation, or reassignment causes rejection and socket closure. No message can select a different desktop subtree because the relay ignores payload ownership for path selection and uses the authenticated principal.

## Testing

- Rust tests cover schema mapping, activity changes, blocker and metadata preservation, coalescing, retry limits, timeouts, reconnect reconciliation, and a runtime integration with two LAN renderer clients sharing one relay publisher.
- Relay unit/integration tests cover own-subtree reconciliation, stale deletion, activity-only replacement, malformed/oversized rejection, cross-desktop isolation, and credential revocation/reassignment.
- Desktop architecture tests prove no task publisher is imported by renderer production paths and no code depends on `navigator.locks`; App tests prove multiple windows only run idempotent credential association/read subscriptions.
- `pnpm --dir apps/desktop test:e2e:cloud-mobile-index` starts `kanna-server`, relay, and fresh Firebase emulators, changes SQLite activity to `working`, and reads the result through `apps/mobile/src/lib/firebase/taskIndex.ts`.
