# Mobile LAN Route Relay Fallback

## Goal

Keep account-owned mobile tasks usable when a previously validated LAN endpoint becomes temporarily unavailable. The desktop remains trusted through the signed-in account, while task traffic falls back to the relay until LAN discovery validates the endpoint again.

## Root cause

The signed-in hybrid client maintains two related but independent pieces of state:

- account desktop inventory, which keeps the machine visible as `Account` in the Machines UI;
- validated LAN endpoint URLs, which allow synchronous terminal and agent stream attachment over LAN.

A transient empty or timed-out LAN inventory read can clear the validated endpoint cache without clearing the account desktop or the previously accepted LAN task route. The task router still selects that LAN route. `clientForDesktop()` then returns a resolving client even though no endpoint is currently validated, and its synchronous stream methods immediately delegate to a disconnected placeholder. This produces `No trusted desktop is available.` while the user remains signed in and the machine remains account-trusted.

## Routing behavior

`clientForDesktop()` will expose a LAN client only when the requested desktop has both account or manual trust and a currently validated LAN URL.

When a task has a cloud identity and its LAN endpoint is not validated, the existing cloud/LAN router will receive no usable LAN client and select the task's cloud fallback route. Terminal and agent streams therefore attach through the relay immediately instead of binding to a disconnected placeholder.

When discovery later validates the LAN endpoint, subsequent task routing can prefer LAN again through the existing merge and route-identity behavior.

LAN-only tasks have no relay identity. They remain temporarily unavailable while their endpoint is unvalidated and become routable again after a successful LAN discovery read. The change will not retain or use a stale endpoint URL.

## Machine inventory and diagnostics

Account inventory remains authoritative for account trust and Machines UI presentation. A LAN timeout or in-flight warning remains a source-specific diagnostic and does not remove the `Account` machine entry.

The fix changes only whether an unvalidated endpoint is eligible for synchronous LAN routing. It does not alter the one-second optional LAN wait, Bonjour discovery, account authentication, or warning text.

## Testing

- Keep the focused regression test that starts signed in with an account desktop and a successfully merged LAN task, then removes LAN discovery results and refreshes desktop inventory.
- Assert that the desktop remains listed from the account source and auth remains `signedIn`.
- Assert that opening the account-owned task uses the relay observer and does not emit `No trusted desktop is available.`
- Preserve coverage showing validated LAN routes remain preferred.
- Preserve coverage showing LAN-only routes become unavailable when LAN cannot supply a client.
- Run the focused mobile routing tests, the full mobile unit suite, and mobile typechecking.

## Non-goals

- Changing Firebase authentication or relay credential handling.
- Retaining last-known LAN URLs after discovery no longer validates them.
- Adding retries or changing the optional LAN timeout.
- Making LAN-only tasks available over the relay.
- Changing the Machines UI or its `Account` and manual-origin labels.
