# Mobile Profile and Machines Design

## Summary

The current mobile profile drawer mixes account identity, desktop availability, LAN pairing, connection errors, sign-out, and a developer transport override. It presents cloud and LAN as competing user-selected connection modes even though transport selection should be automatic. Starting the current LAN flow also replaces the previously visible connection information, leaving the drawer with a confusing and incomplete status.

This design separates identity from machine management:

- the profile drawer shows only the user's account identity, a route to Machines, and account actions;
- a dedicated Machines screen shows a single deduplicated inventory of account-discovered and manually paired desktops;
- QR and short-code pairing let users add a machine whether or not they are signed in;
- Kanna chooses LAN or cloud transport automatically for each operation;
- manual pairings can be removed without affecting account-owned machines.

## Goals

- Make the profile drawer understandable at a glance.
- Stop presenting LAN as a connection mode the user must manually activate.
- Give users one place to see every machine available to the mobile app.
- Support manual LAN pairing while signed in or signed out.
- Add QR pairing while retaining a short-code fallback.
- Deduplicate manually paired and account-discovered records for the same desktop.
- Keep task routing contextual instead of introducing a global active machine.
- Preserve useful partial results when one discovery source is unavailable.

## Non-Goals

- Adding a Machines destination to the bottom navigation.
- Letting users globally select an active/default machine.
- Letting mobile unregister a desktop from a cloud account.
- Exposing a manual LAN/cloud transport switch in production UI.
- Replacing the existing cloud desktop registration system.
- Building cross-account machine sharing.
- Adding remote pairing for signed-out users; manual pairing is local-network only.
- Redesigning task creation beyond consuming the normalized machine inventory.
- Expanding the current LAN trust model into a new end-to-end authorization protocol.

## Product Model

### Identity Is Not Connection State

Authentication answers which Kanna account the user is using. A signed-in account does not need a second "cloud connected" status in the profile drawer. Authentication states remain:

- signed out;
- signing in;
- signed in;
- sign-in error.

Machine availability is a separate concern and belongs on the Machines screen.

### Machines Are Durable Identities

Every desktop has a stable `desktopId`. The mobile app builds one normalized machine record per `desktopId`, regardless of how many sources report that machine.

A machine may have either or both origins:

- `account`: the desktop is registered to the signed-in user's account;
- `manual`: the phone has explicitly paired with the desktop over the local network.

Origin is different from transport. `account` and `manual` describe why the mobile app trusts and knows the machine. `lan` and `cloud` describe how an operation can currently reach it.

### No Global Active Machine

The Machines screen is informational and administrative. Tapping a machine does not make it globally active.

Machine routing stays contextual:

- an existing task routes to its owning `desktopId`;
- task creation asks for a machine when needed;
- other machine-scoped actions carry an explicit `desktopId`.

The existing persisted `selectedDesktopId` may continue temporarily as an implementation detail while call sites migrate, but the Machines screen must not expose it as a user-facing selection state.

## User Experience

### Profile Drawer

The profile badge continues to open a bottom sheet.

When signed in, the sheet contains:

1. avatar initials, display name, and email;
2. a Machines row showing the total known count and available count;
3. Sign Out.

When signed out, the sheet contains:

1. the existing email/password sign-in form;
2. a Machines row that remains available without authentication.

The drawer does not contain:

- a cloud connection card;
- a LAN connection card;
- a Connect on Local Network button;
- pairing codes;
- the Force Cloud developer toggle.

Tapping Machines closes the sheet and opens the full Machines screen.

### Machines Screen

The existing Desktops screen becomes the Machines screen and is reached from the profile drawer. It uses the normal app screen shell with:

- a back button;
- the title `Machines`;
- an add button.

The inventory is split into Available and Offline sections. Each row shows:

- machine name;
- availability;
- a plain-language reachability summary such as `Available nearby and remotely`, `Available remotely`, or `Last seen yesterday`;
- subtle origin labels for `Account`, `Paired`, or both.

Rows do not show a selected state. They may open machine details later, but selection is not part of this design.

An empty screen explains that signed-in machines appear automatically and provides the Add Machine action for local pairing.

### Add Machine

The add button opens an Add Machine sheet with two equivalent inputs:

1. Scan QR Code;
2. Enter Pairing Code.

QR is the primary action because it carries the desktop identity alongside the short-lived code. Manual code entry remains available for devices or environments where camera scanning is impractical.

The sheet tells the user to open Kanna on the desktop and start mobile pairing. Starting pairing on desktop displays both a QR code and a six-character code for the same five-minute pairing session.

### Remove Manual Pairing

Only machines with a `manual` origin expose `Remove Pairing`.

Removal requires confirmation and deletes the phone's local manual trust record. If the same `desktopId` also has an `account` origin, the confirmation explains that the machine will remain visible through the signed-in account. Account-only machines do not expose removal.

## Normalized Machine Model

The UI consumes a derived record shaped like:

```ts
interface MobileMachine {
  desktopId: string;
  displayName: string;
  origins: {
    account: boolean;
    manual: boolean;
  };
  availability: {
    lan: boolean;
    cloud: boolean;
    lastSeenAt: string | null;
  };
  lanEndpoints: TrustedDesktopLanEndpoint[];
}
```

The exact type name may follow existing repository conventions, but its semantics are fixed:

- merge records by exact stable `desktopId`;
- prefer the freshest non-empty display name;
- retain manual LAN endpoints when an account record appears;
- compute availability from live Bonjour discovery, validated status responses, and cloud presence;
- never create duplicate rows for different origins;
- sort available machines before offline machines, then sort by display name.

The normalized selector is pure and separately tested. Screens do not merge raw source arrays themselves.

## Automatic Transport Resolution

Operations resolve a transport for their target `desktopId` at call time:

1. If a matching Bonjour service is reachable and the machine is trusted through the current account or a manual pairing, use the validated LAN endpoint.
2. Otherwise, if the user is signed in and the machine is reachable through the relay, use cloud transport.
3. Otherwise, report that the target machine is offline.

LAN and cloud are fallback paths, not sticky global modes. A temporary LAN failure must not erase cloud inventory or account identity, and a cloud failure must not erase manually paired machines.

The developer-only Force Cloud control remains available for transport testing but moves out of Profile into developer diagnostics.

## Pairing Contract

### Desktop Session

Desktop Kanna starts a five-minute pairing session in `kanna-server`. The session includes:

- a cryptographically random six-character code;
- `desktopId`;
- desktop display name;
- expiration time.

The code remains private to the desktop pairing surface and the pairing claim endpoint. General status responses must not be the mechanism by which mobile learns or validates the active code.

The desktop renders:

- the six-character code;
- a QR payload using a versioned Kanna pairing format.

The versioned payload contains the stable desktop identity and pairing code. It does not make the pairing permanent by itself; the mobile app must still discover and validate the desktop over the local network before storing trust.

### Mobile Discovery and Claim

For QR pairing:

1. Mobile scans and validates the versioned payload.
2. It finds the matching `desktopId` among Bonjour services.
3. It submits the code and mobile device metadata to that desktop's pairing claim endpoint.
4. The desktop verifies that the session exists, is unexpired, and matches the code.
5. Mobile validates the returned desktop identity and persists the manual record.

For manual code pairing:

1. Mobile normalizes the six-character code.
2. It queries discovered Kanna Bonjour candidates through the pairing claim endpoint.
3. Exactly one candidate must accept the code.
4. Mobile validates and persists that desktop identity.

Failed candidates must not create or modify trust. Pairing codes are single-use after a successful claim. The server rate-limits failed claim attempts for the active session.

The phone does not need a Kanna account for either flow.

### QR Implementation Boundary

Desktop QR rendering is code-only and does not add a runtime dependency on software installed on the build machine. Mobile scanning uses an Expo-compatible camera/barcode package included in the app build. Because this adds native code and permissions, the mobile OTA `runtimeVersion` must be bumped according to project policy.

## State and Data Flow

```text
Account registry ----\
                      +--> normalize by desktopId --> Machines UI
Manual trust store --/              ^
                                    |
Bonjour + LAN status ---------------+ availability
Relay presence ---------------------+ availability

Task/action with desktopId
        |
        +--> reachable trusted LAN? --> LAN client
        |
        +--> reachable cloud relay? --> cloud client
        |
        +--> neither -----------------> offline error
```

Manual trust remains device-local and survives account sign-in, sign-out, and account switching. Account-scoped inventory is cleared when the authenticated UID changes, while manual trust is preserved and re-merged with the new account inventory.

## Loading, Empty, and Error States

### Profile

- Sign-in errors remain attached to the sign-in form.
- Machine availability errors never replace account identity.
- Machine counts may show a neutral loading state while inventory initializes.

### Machines

- Initial load shows machine-row skeletons or a compact loading state.
- No account and no manual records shows an Add Your First Machine empty state.
- A cloud inventory error keeps manual machines visible and shows a non-blocking cloud warning.
- A Bonjour/discovery error keeps account machines visible and shows a non-blocking local discovery warning.
- An individual offline machine stays in the Offline section instead of disappearing.

### Pairing

- Camera permission denial keeps code entry usable and offers a route to system settings.
- A malformed QR payload is rejected without making a network request.
- An unsupported QR payload version asks the user to update Kanna.
- An invalid or expired code explains that pairing must be restarted on desktop.
- A valid code with no matching reachable desktop explains that both devices must be on the same local network.
- Multiple accepting candidates are treated as an error rather than choosing arbitrarily.
- Pairing an existing `desktopId` merges and refreshes that machine's manual record.

### Removal

- Removal is optimistic only after durable local persistence succeeds.
- A persistence failure leaves the row intact and reports the failure.
- Removing the manual origin from a dual-origin record immediately recomputes the same row as account-only.

## Existing UI Changes

- Replace AccountSheet's connection presentation and local-connect action with a Machines entry point.
- Rename DesktopsScreen and its navigation copy to Machines while preserving the internal route value if changing it would create unrelated migration work.
- Remove Start Pairing and Switch Desktop from the More command palette. Machine management lives in Machines.
- Extend Desktop Preferences Mobile Access to render the QR alongside the existing code.
- Move Force Cloud to developer diagnostics.
- Preserve stable E2E identifiers where their semantic control remains; replace obsolete connection/local-connect identifiers with machine-navigation and pairing identifiers.

## Testing

### Pure and Component Tests

- merge account-only, manual-only, and dual-origin records by `desktopId`;
- preserve manual records across auth changes;
- sort available and offline machines deterministically;
- prefer LAN and fall back to cloud per target machine;
- render signed-in and signed-out profile drawer states with Machines always reachable;
- render machine counts, origin labels, availability, empty states, and partial errors;
- show removal only for records with a manual origin;
- update a dual-origin record to account-only after manual removal;
- encode and decode the versioned QR payload;
- reject malformed and unsupported QR payloads;
- handle camera permission states without blocking code entry.

### Rust and HTTP Tests

- pairing session generation and expiration;
- single-use successful claims;
- invalid, expired, and rate-limited claims;
- pairing-store persistence;
- claimed desktop identity in the response;
- general status does not expose a claimable pairing secret.

### Integration and E2E Tests

- pair a signed-out phone with a discovered desktop by code;
- pair by QR payload through the same claim contract;
- sign in after manual pairing and deduplicate the matching cloud desktop;
- automatically use LAN for a reachable account-discovered machine and relay when LAN becomes unavailable;
- remove a manual-only machine;
- remove the manual origin from a dual-origin machine while retaining its account row;
- update the existing Appium profile smoke flow to open Machines;
- verify invalid and expired code recovery in the simulator harness.

Physical-device camera permission and QR scanning receive human verification after merge. Agent automation must not install, launch, or run Appium on a physical iPhone.

## Migration and Compatibility

- Existing persisted `TrustedDesktopRecord` values migrate directly into manual-origin machine records.
- Existing account `DesktopSummary` values become account-origin records.
- Existing `selectedDesktopId` remains readable for task routing compatibility during migration but is not rendered as a Machines selection.
- Existing pairing codes remain six hexadecimal characters, while the new QR wrapper is explicitly versioned.
- The native camera dependency requires a mobile runtime-version bump and a new native build; it cannot ship as a JS-only OTA update.

## Success Criteria

- The profile drawer never displays LAN/cloud as competing connection states.
- Users can reach Machines from Profile while signed in or signed out.
- The Machines screen shows one row per `desktopId` across account and manual sources.
- Users can manually add a nearby machine by QR or code without authentication.
- Signed-in account machines use reachable LAN transport automatically and fall back to relay without user action.
- Manual pairings can be removed; account-only machines cannot.
- Partial discovery failures do not erase machines from unaffected sources.
