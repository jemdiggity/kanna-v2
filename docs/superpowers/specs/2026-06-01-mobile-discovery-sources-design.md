# Mobile Discovery Sources Design

## Goal

Remove the vestigial mobile server URL runtime path. Kanna Mobile should discover task sources from cloud state and from trusted LAN peers discovered on the local network, not from an environment-provided `kanna-server` URL.

## Product Behavior

Mobile has two runtime discovery sources:

1. **Cloud discovery** when the user is signed in.
   - Mobile reads the user cloud task index.
   - Mobile reads cloud-known desktops through the existing remote/relay path.
   - Cloud tasks are visible even when no desktop is currently reachable on LAN.

2. **Bonjour discovery** for LAN reachability.
   - Mobile browses for Kanna desktop services on the local network.
   - Bonjour results are only usable when they match a locally persisted trusted desktop.
   - Untrusted Bonjour results are discovery candidates only; they must not expose tasks or accept commands.

There is no normal runtime fallback to `127.0.0.1`, the Metro host, `KANNA_MOBILE_SERVER_URL`, or `EXPO_PUBLIC_KANNA_SERVER_URL`.

## Trusted Peers

The mobile app already persists trusted desktop records. That store remains the source of LAN trust.

Each trusted desktop should store:

- desktop id,
- display name,
- known LAN endpoints,
- last seen timestamp.

Bonjour discovery can refresh endpoint addresses for an already trusted desktop. It cannot create trust by itself.

QR or pairing flows can add trusted desktops in future slices. This design only requires the runtime source model to support them cleanly.

## Architecture

Replace `baseUrl`-driven app runtime with source-driven client resolution:

- `CloudSource`
  - active when Firebase auth is signed in,
  - lists cloud tasks and cloud desktops,
  - routes live actions through the relay when possible.

- `TrustedBonjourLanSource`
  - active when the local trust store contains peers,
  - consumes Bonjour-discovered endpoints,
  - validates each endpoint with `/v1/status`,
  - only uses endpoints whose reported desktop id matches a trusted desktop id.

- `DisconnectedSource`
  - active when neither cloud nor trusted LAN sources are available,
  - does not attempt localhost or inferred URLs,
  - leaves the app in a useful empty state with sign-in and pairing entry points.

The app client should choose sources by capability, not by a configured URL. Signed-in cloud remains primary for cloud-visible task lists. Trusted LAN remains available for local-only/offline-cloud cases and for live desktop commands when a trusted desktop is reachable.

## kd and Development

`kd dev up --mobile` should stop injecting `EXPO_PUBLIC_KANNA_SERVER_URL`.

Development should use the same source model as production:

- cloud mode uses production cloud by default, or Firebase/relay emulator env when `--emulators` is enabled,
- LAN mode uses trusted peer state plus Bonjour,
- tests that need a fake LAN server should inject a test transport/client rather than reviving the app-level URL bootstrap path.

Existing E2E helpers may still start fake servers internally, but the production app runtime should not read a public env URL to discover them.

## Error Handling

- Signed out with no trusted peer: show disconnected/empty state, no network error.
- Signed in with no cloud tasks: show an empty task list, no LAN fallback unless a trusted LAN peer is reachable.
- Bonjour unavailable or local network permission denied: cloud remains usable; LAN peers show as unavailable.
- Trusted endpoint reports a different desktop id: ignore it and keep searching.
- Relay unavailable: cloud task snapshots remain visible; live actions report a command-specific error.

## Testing

Unit coverage should prove:

- no app runtime code reads `EXPO_PUBLIC_KANNA_SERVER_URL` or infers a server URL from Metro,
- signed-in mobile lists cloud tasks without a LAN URL,
- signed-out mobile with no trusted peers does not call localhost,
- trusted Bonjour endpoints are accepted only when `/v1/status.desktopId` matches persisted trust,
- untrusted Bonjour endpoints do not appear as usable desktops,
- `kd` mobile dev plans no longer inject the server URL env var.

E2E coverage should be added once the native Bonjour test harness exists. Until then, the narrower tests above cover the routing and trust rules.
