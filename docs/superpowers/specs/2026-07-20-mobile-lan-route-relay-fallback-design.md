# Mobile LAN Route Relay Fallback

## Goal

Keep account-owned mobile tasks usable when a previously validated LAN endpoint becomes temporarily unavailable. The desktop remains trusted through the signed-in account, while task traffic falls back to the relay until LAN discovery validates the endpoint again.

## Root cause

The signed-in hybrid client maintains two related but independent pieces of state:

- account desktop inventory, which keeps the machine visible as `Account` in the Machines UI;
- validated LAN endpoint URLs, which allow synchronous terminal and agent stream attachment over LAN.

A transient LAN failure currently crosses two different deadlines. The cloud/LAN client stops waiting after 1,000 ms and preserves the last accepted task projection, while the underlying Bonjour `/v1/status` probe can remain pending for 5,000 ms. During that gap, the trusted-LAN client still exposes the previously validated URL, so the preserved task route continues to identify as LAN even though the optional read has already declared that source unavailable.

When the late Bonjour probe finally fails, desktop inventory clears the validated URL. That changes the route returned by `clientForDesktop()`, but it does not publish a new task snapshot. The mobile controller therefore has no reason to compare the selected task's route identity again, and an already-open terminal or agent subscription remains attached to the failed LAN transport. Repeated refreshes then alternate between `Optional LAN read timed out after 1000ms` and `Optional LAN read is already in flight.`

## Routing behavior

`clientForDesktop()` will expose a LAN client only when the requested desktop has both account or manual trust and a currently validated LAN URL. A healthy revalidation that completes inside the optional wait keeps that URL and preserves LAN preference.

When an optional LAN read reaches its 1,000 ms deadline while Bonjour validation is still pending, the hybrid routing layer will expire synchronous LAN routability before returning its preserved task projection. It will then publish a route-identity change. This makes the optional-read deadline the single boundary at which stream routing stops treating the old URL as usable; the longer Bonjour probe may still finish for inventory and diagnostics, but cannot keep task traffic pinned to stale LAN state. A later read that only reports the same probe as already in flight does not independently invalidate a route, and a task-list failure after status validation succeeds preserves the validated LAN route.

When a task has a cloud identity and its LAN endpoint is not validated, the existing cloud/LAN router will receive no usable LAN client and select the task's cloud fallback route. Terminal and agent streams therefore attach through the relay immediately instead of binding to a disconnected placeholder.

The mobile controller will subscribe to route-identity changes. If the selected task's effective route changes, it will use the existing `startTaskView()` identity check to close the prior subscription and attach the appropriate replacement without clearing the user's selection. Terminal, agent, and companion paths share this reconciliation boundary.

When discovery later validates the LAN endpoint, routing will publish another identity change so an active task can prefer LAN again. Unchanged identities remain no-ops, preventing duplicate subscriptions.

LAN-only tasks have no relay identity. They remain temporarily unavailable while their endpoint is unvalidated and become routable again after a successful LAN discovery read. The change will not retain or use a stale endpoint URL.

## Machine inventory and diagnostics

Account inventory remains authoritative for account trust and Machines UI presentation. A LAN timeout or in-flight warning remains a source-specific diagnostic and does not remove the `Account` machine entry.

The fix does not alter the one-second optional LAN wait, the five-second Bonjour probe, account authentication, or warning text. It aligns synchronous route validity with the existing optional-read deadline and adds notification for effective route changes.

## Testing

- Replace the previous immediate-empty-discovery regression with fake timers and a deferred `/v1/status` response after an initially successful LAN validation.
- Open an account-owned PTY task through `app.controller.openTask(...)` and verify that its first subscription uses LAN.
- Trigger the real desktop/task refresh path while the status probe hangs, advance exactly 1,000 ms, and verify that the existing LAN subscription closes and a relay terminal subscription opens for the owner-local task identity.
- Assert that the desktop remains listed from the account source, auth remains `signedIn`, and no manual reopen is required.
- Cover the same controller route-reconciliation contract for agent streams in the controller unit suite if the shared implementation is not already proven independently of stream type.
- Preserve coverage showing validated LAN routes remain preferred.
- Preserve coverage showing LAN-only routes become unavailable when LAN cannot supply a client.
- Run the focused app-model, cloud/LAN-client, and controller suites; mobile typechecking; the repository test suite; and daemon tests requested in review.

## Non-goals

- Changing Firebase authentication or relay credential handling.
- Retaining or using last-known LAN URLs after the optional LAN deadline.
- Adding retries or changing the optional LAN timeout.
- Making LAN-only tasks available over the relay.
- Changing the Machines UI or its `Account` and manual-origin labels.
