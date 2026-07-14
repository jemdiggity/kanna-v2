# Mobile Task Status Rendering Design

## Goal

Match the desktop task-title typography in every mobile task list: unread tasks are bold, working tasks are italic at normal weight, and idle tasks are normal.

## Scope

This change covers the complete activity lifecycle needed for reliable mobile
rendering: desktop-to-Firestore publication, Firestore and LAN collection
updates, mobile controller read handling, transport routing, and task-title
typography. It does not add visible status labels, icons, badges, ordering
changes, or task-detail typography.

## Data Model and Flow

Mobile will define task activity as `"idle" | "working" | "unread"`. `TaskSummary.activity` remains optional and nullable so mobile can safely consume older cloud documents or responses that omit the field.

The LAN and relay task APIs already include activity, so task-list reads continue
passing task summaries through unchanged. The mobile Firestore task mapper will
retain valid activity values from desktop cloud snapshots. Missing or
unrecognized values behave as idle for rendering.

Desktop structural reconciliation remains keyed by a stable structural
fingerprint. A second activity fingerprint detects only semantic
`working`/`unread`/`idle` changes. Those changes enter a bounded latest-value
queue and update only the matching cloud task document's `activity` field.
Structural reconciles and activity writes are serialized so a reconcile cannot
overwrite a newer activity update.

Exactly one desktop window owns publication through a browser-managed,
same-origin exclusive Web Lock. Other windows remain queued readers until the
owner closes; a voluntary close retains the lock until already-issued cloud
writes settle, and an unexpected webview exit lets the browser release it. The
next owner forces a fresh reconcile. If Web Locks are unavailable, publication
fails closed instead of risking competing writers.

The graceful per-window close path waits for both publication drains and lock
release before deliberately closing the native window. Whole-process Quit and
updater relaunch still rely on browser teardown to release the lock; coordinating
all webviews for a pre-exit drain is separate shutdown hardening.

Publication state is scoped to both lock ownership and the current
authentication generation. Every sign-in, including reauthentication as the
same user, forces a reconcile, while sign-out or ownership loss invalidates
queued work. Structural changes coalesce to one in-flight reconcile plus one
latest request, and activity changes coalesce to one in-flight write plus the
latest value per task. Transient failures retry with bounded backoff and are
acknowledged only after success. Expected-user checks prevent queued work from
crossing accounts, and activity retries revalidate authoritative open-task
state before any fallback can recreate a missing document.

Mobile repo and recent task collections suppress identical refreshes to preserve
UI state. Activity participates in that equality check so an activity-only LAN
poll or cloud snapshot update publishes new state and rerenders the card. Search
results already publish every refresh.

Cloud task subscriptions use Firestore `onSnapshot` as both the initial and live
source. They do not race a parallel `getDocs` prime against newer activity, and
listener generations discard callbacks from desktops that were removed and
re-added.

## Unread Lifecycle

Opening a visibly unread task schedules a mark-read request after a one-second dwell.
If the selected task becomes unread while it remains open, that transition starts
the same dwell. The controller keys the timer and response to a generation of
task-detail visibility, selected task id, and every stored copy's activity;
navigation, a hidden detail, disagreement between collections, or a newer
activity transition cancels stale work. Immediately before the request and
before applying its response, the controller verifies that the detail remains
visible and every present copy of the same task still agrees on unread.

The request uses `POST /v1/tasks/{task_id}/actions/mark-read` through the shared
client contract. LAN calls the endpoint directly. Remote calls use the existing
cloud-task owner routing, refreshed from the current live task index before a
mutation, so a cloud task id reaches its current owner desktop and local task
id. Only an authoritative `idle` response updates all local task
collections; a null/no-op response never overwrites newer activity.

Mark-read failures do not poison the overall connection or stop LAN polling.
They retry with bounded backoff and become eligible for another bounded attempt
after a later successful collection reconciliation.

## Rendering

`TaskCard` will apply activity styling only to the task title:

- `unread`: bold, non-italic
- `working`: normal weight, italic
- `idle`, missing, or unrecognized: normal weight, non-italic

Repo labels, scope labels, stage pills, previews, card layout, and task ordering remain unchanged. Because repo, recent, and search results all reuse `TaskCard`, they receive the same behavior automatically.

## Compatibility and Error Handling

No server or database migration is required. The Kanna server already exposes
the idempotent mark-read action and desktop cloud snapshots already contain
activity. Legacy or malformed cloud values degrade to normal title typography
rather than preventing task rendering. Publication failures use the existing
rate-limited cloud error reporting; mark-read failures stay nonfatal. Neither
path can force a stale local idle state.

## Testing

Automated coverage verifies:

1. The exclusively locked desktop publisher reacts to activity-only transitions
   without periodic full reconciles; ownership handoff, authentication
   invalidation, coalescing, retries, drain-before-release, and serialization
   preserve ordering.
2. The Firestore live subscription emits when only activity changes and the LAN
   background poll updates the same task for an activity-only response.
3. LAN and remote transports route mark-read correctly, including refreshed
   cloud owner ids.
4. Opening unread tasks and receiving unread while already open converge to idle
   after the race-safe debounce; hidden details, mixed collection state, stale
   responses, and transient failures cannot produce a false idle.
5. `TaskCard` keeps exact unread/working/idle typography assertions and exposes
   an accessibility activity value for the relay Appium flow.
6. The relay fixture changes only the Firestore activity field and observes
   working, unread, and idle on the rendered task card. It then makes the owner
   task unread, opens it, verifies the real relay mark-read action changes the
   owner to idle, and observes idle on the returned task card.

Appium/XCUITest exposes native accessibility attributes but not React Native
`Text` style properties such as resolved `fontWeight` and `fontStyle`. The relay
flow therefore proves the rendered card received each activity through a stable
accessibility value, while `TaskCard.test.tsx` remains the exact typography
assertion. A deterministic screenshot comparison or a native font-descriptor
probe would be required to assert glyph traits end to end.
