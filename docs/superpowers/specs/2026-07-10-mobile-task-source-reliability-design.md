# Mobile Task Source Reliability Design

Date: 2026-07-10
Status: Approved
Scope: Reliable mobile task discovery and navigation across signed-in cloud and trusted LAN sources

## Problem

The current mobile client treats cloud and trusted LAN task access as a global either/or fallback. That violates the existing source-driven mobile design and creates two user-visible failures:

- Production can select the preserved trusted LAN context before Firebase auth and cloud listeners settle. Because the controller reports a LAN connection, it never starts the cloud task subscription, so cloud-only tasks remain invisible.
- Staging can receive a valid Firestore snapshot and then overwrite it with an older bootstrap collection read. Tasks appear, disappear, and reappear as asynchronous reads finish in a different order.

Persisted navigation state creates a related shell failure. A stale `selectedTaskId` is treated as visible task detail even when no task resolves to that ID, hiding the top bar and account badge while the task list is on screen.

The installed production and staging apps were both built from the current source with the correct native identities. Reinstalling does not clear persisted auth, trusted desktop, selection, or cached OTA state, so correctness must not depend on a clean app sandbox.

## Goals

- Signed-in users always see cloud-indexed tasks, regardless of trusted LAN state.
- Reachable trusted LAN tasks supplement cloud tasks instead of replacing them.
- The same task discovered through both sources appears once and routes through the best available path.
- Older reads, listeners, auth states, or bootstrap runs cannot overwrite newer state.
- Foreground and manual refresh recover from idle, error, and failed-listener states without blanking the last good list.
- A stale persisted task selection cannot hide the task-list shell or account badge.

## Non-Goals

- Changing the Firestore task schema or desktop publisher contract.
- Redesigning cloud repository identity across multiple desktops.
- Adding offline mutation queues or retrying uncertain mutations automatically.
- Clearing user data during `kd` installs.
- Changing OTA infrastructure or the mobile native runtime version.

## Source Model

Cloud and trusted LAN are independent capabilities.

- The cloud source is active whenever Firebase auth is signed in and a relay URL is configured. It owns the durable cross-desktop task projection and keeps the controller in remote/live mode even when the cloud list is empty.
- The LAN source is active when Bonjour resolves a reachable endpoint whose `/v1/status.desktopId` matches a persisted trusted desktop. It exposes direct local tasks and a lower-latency route to that desktop.
- Bonjour service changes enqueue the same complete-snapshot publication used by cloud and relay-presence callbacks. Once `/v1/status` validates an endpoint, the remaining reads in that snapshot use the validated base URL; a second discovery miss cannot turn a healthy LAN snapshot into an authoritative empty list.
- `forceCloud` disables LAN contribution and routing, but it does not change cloud subscription semantics.

No decision may be based on whether either source currently contains at least one task. An empty cloud snapshot is valid data, not permission to replace the whole workspace with LAN data.

### Task merge

A full successful LAN recent-task read is associated with the desktop ID returned by that LAN endpoint. A cloud task and LAN task represent the same owner task when:

- `cloud.ownerDesktopId === lanDesktopId`,
- `cloud.ownerLocalTaskId === lan.id`, and
- when the cloud snapshot includes `localRepoId`, it equals `lan.repoId`.

`cloud.id` is never compared with `lan.id`; the cloud ID is an independent projection identity.

For a duplicate:

- retain the cloud ID and cloud owner/routing fields as the displayed identity,
- retain the cloud repository identity used by the cloud workspace,
- when cloud omitted `ownerLocalRepoId`, record the matched LAN repository ID in that owner field so a later enriched cloud projection remains the same duplicate,
- prefer LAN values for mutable owner data such as title, stage, snippet, and agent type when LAN supplies them,
- use cloud values for metadata LAN does not expose, such as owner identity, repo name, and agent provider.

Cloud order is preserved. Matched rows are replaced in place and unmatched LAN tasks are appended in LAN order. A later schema change may add timestamps and a stronger cross-desktop repository key; this fix does not invent either.

When a full LAN read succeeds, the LAN list is authoritative for that desktop's open local tasks. A cloud projection owned by that same desktop but absent from LAN is stale and is suppressed. When the LAN read fails, cloud rows are retained because absence has not been proven.

### Repository and desktop merge

Repository lists are derived from the merged task list and supplemented by explicit source repository lists. Existing repository IDs remain unchanged.

Desktop lists are merged by desktop ID. A desktop visible through both sources keeps its cloud identity and relay metadata while reporting `connectionMode: "both"` and current LAN reachability. Cloud-only and LAN-only desktops remain visible.

## Per-Task Routing

The composed client maintains an atomically replaced route table from displayed task ID to source-specific IDs.

Same-turn recent, repository, and search collection requests share one composed task-read batch, which keeps controller `Promise.all` reads paired with one route table without letting a hung incidental read poison later retries. Authoritative live publications never join an incidental batch: they start a fresh composed read, while incidental callers arriving during that publication use the accepted last-good snapshot until the replacement is complete.

- A duplicate cloud/LAN task uses the LAN local task ID while that trusted endpoint is reachable.
- A LAN-only task uses LAN.
- A cloud-only task uses its cloud route through the relay.
- A failed or timed-out LAN reprobe preserves each last-good LAN-backed display identity, mutable metadata, and route. Fresh unrelated cloud rows may still join the collection, but cloud membership changes cannot rename or reroute preserved LAN rows. Explicit LAN disablement or a complete replacement snapshot may replace them.

The route applies to terminal/agent streams, input, permissions, interrupt, stage advance, close, and merge actions. A mutation that fails after being sent over LAN is reported; it is not transparently retried through cloud because the first attempt may already have executed.

Task creation is routed by `input.desktopId`, not by the presence of any tasks. It uses LAN only when the requested desktop is the currently reachable trusted LAN desktop; otherwise it uses cloud. Pairing remains LAN-only.

The relay transport's internal cloud route map is replaced from each complete cloud snapshot rather than accumulating stale routes indefinitely.

## Auth And Bootstrap Ordering

`MobileAuthSession.initialize()` must not resolve until the first authoritative Firebase auth observation has arrived. `getCurrentUser()` may be temporarily null while React Native persistence hydrates, so registering the listener is not sufficient. Initialization remains idempotent and installs one Firebase subscription.

Bootstrap is single-flight for duplicate callers, but a meaningful request that arrives during an active run queues one trailing run. This covers auth or transport changes that invalidate the active run instead of allowing the new request to be absorbed by the old promise.

For signed-in remote mode:

1. Preserve the last good task collections and selected task.
2. Start a new versioned merged-task subscription.
3. Refresh desktop metadata independently.
4. Let the first complete merged subscription snapshot, including a genuinely empty snapshot, become authoritative for task collections.
5. Ignore callbacks from older subscription versions.

Polling collection reads do not compete with the live subscription in this mode. A subscription error retains the last good snapshot, reports the error, and attempts a versioned one-shot merged read. Manual or foreground refresh replaces the subscription and therefore provides another recovery path.

LAN-only mode continues to load and poll collections normally.

## Firestore Subscription Consistency

The nested desktop/task listener publishes atomic user-level snapshots.

- The root desktop callback records the complete current desktop set before installing any child listener. This prevents synchronous child callbacks from exposing a partial list.
- Each child listener has a generation token. Callbacks from a removed, re-added, replaced, or unsubscribed generation are ignored.
- The first aggregate is withheld until every desktop in that root generation has produced an initial snapshot.
- Subsequent child updates replace that desktop's complete slice and emit one aggregate.
- Removing a desktop removes its tasks and emits after any new-desktop hydration barrier is satisfied.
- Child errors retain that desktop's last good tasks but keep the desktop in the hydration barrier, so healthy siblings cannot publish a partial or stale aggregate. The scoped error makes the app-model owner replace the subscription, perform one complete one-shot recovery, and restart the live subscription only after that read succeeds.
- A root error retains the last good aggregate and surfaces a subscription error.

The redundant `getDocs()` prime is removed. Firestore's child `onSnapshot` already produces an initial snapshot, and a second writer for the same per-desktop cache is the source of the stale-prime race.

Task documents are validated at the read boundary. A malformed document is skipped and reported without preventing valid peers from appearing. Ordering uses normalized `updatedAt DESC` with stable task identity as a tie-breaker.

## Controller State Ownership

Live subscription updates receive an epoch and are the sole writers for task collections in signed-in remote mode. They update recent tasks, derive repositories, select a valid repository, update the repo-scoped slice, refresh active search results, and reconcile the selected task only after the complete snapshot arrives. Merged publications use a single-flight drain with one trailing-latest slot: callbacks that arrive during a LAN probe coalesce without invalidating the complete snapshot already in flight, so sustained callbacks make bounded progress without publishing a partial cloud phase.

LAN polling reads use a task revision guard so an older read cannot commit after a newer controller update. Desktop refresh has its own single-flight state and does not determine task-source ownership.

Every background or inactive to active transition requests controller refresh, including when the current connection state is `idle` or `error`. The intentional immediate OTA-reload path remains the only exception.

## Shell And Selection

`App` resolves `selectedTask` once from current collections. Task detail is visible only when:

- the connection is connected,
- the selected task resolves to an actual task, and
- the active view is not More.

That one boolean controls detail rendering, shell styling, the top bar/account badge, and the floating toolbar. A raw stale `selectedTaskId` cannot hide shell controls. After an authoritative collection snapshot arrives, normal reconciliation clears a missing selection and its task stream state.

## Error Behavior

- Cloud listener/read failure with cached tasks: keep the last good tasks and report the failure.
- Cloud failure with reachable LAN: keep LAN tasks visible.
- LAN read failure: keep the last-good LAN-backed display IDs, rows, metadata, and routes while retaining fresh unrelated cloud rows; cached LAN absence never suppresses a fresh cloud row or recomputes a LAN display identity.
- Both sources unavailable with no cached data: surface a connection error while leaving account access visible.
- Obsolete auth, bootstrap, source-read, or listener callbacks: ignore without mutating current state.
- Failed mutation: show the original route error and do not cross-retry.

## Testing

All race tests use deferred promises or captured callbacks; no timing sleeps are needed.

### Auth and controller

- Delayed first auth callback keeps initialization pending, then restored sign-in bootstraps cloud.
- Sign-in during a stale in-flight bootstrap queues and completes a second bootstrap.
- A deferred first live snapshot preserves existing tasks and selection.
- A live snapshot cannot be overwritten by an older collection read.
- Empty complete snapshots reconcile selection; partial or obsolete callbacks do not.
- Foreground refresh runs from connected, idle, and error states and preserves the last good list until replacement.

### Source composition and routing

- Cloud-only, LAN-only, and duplicate tasks are all visible.
- Duplicate matching uses owner desktop, owner-local repo when available, and owner-local task ID; it never uses cloud ID equality.
- A matched duplicate whose first cloud row omitted the owner-local repository records the LAN repository and remains one row if a later cloud callback supplies that repository.
- LAN metadata wins mutable fields while cloud identity and routing fields remain.
- Successful LAN absence suppresses stale same-owner cloud rows; rejected LAN reads preserve them.
- Mixed tasks independently route streams and actions to the correct raw IDs.
- Failed or timed-out LAN reprobes retain established LAN-backed display IDs and routes even when duplicate or collision membership changes; explicit LAN disablement replaces them with cloud routes.
- A LAN success that arrives after its optional timeout but before the same read's cloud result remains authoritative and cannot be overwritten by that read's fallback phase.
- Sustained cloud and presence callbacks coalesce behind one complete read and a trailing-latest read rather than starving publication.
- Same-turn recent/repository/search readers share one route-backed source snapshot, while a later authoritative publication bypasses an incidental or hung read and cannot be consumed as the older cloud generation.
- Task creation routes by the explicit destination desktop.
- Cloud route snapshots atomically remove obsolete routes.

### Firestore task index

- Multiple desktops emit no partial initial aggregate.
- Removed/re-added desktops ignore callbacks from older generations.
- Child and root errors retain last-good data and surface errors.
- Unsubscribe ignores every late callback.
- Equal timestamps use the stable identity tie-breaker.
- A malformed document does not suppress valid task documents.

### Shell

- Idle/error plus a stale ID shows the task list, toolbar, and account badge.
- Connected plus an unresolved ID shows shell controls.
- Connected plus a resolved task hides shell controls for detail.
- More always shows shell controls.

## Delivery

The implementation is TypeScript-only and keeps mobile runtime version `1.0.0`; it is OTA-compatible. This task does not publish an OTA or deploy cloud services. Because the currently installed production app preserves its sandbox and cached update state, final device verification must use a newly built production bundle or a functioning signed production OTA without clearing app data.
