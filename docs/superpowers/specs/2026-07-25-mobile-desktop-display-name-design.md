# Mobile Desktop Display Name Design

## Problem

The mobile machine inventory can display a desktop's stable identifier, such as
`desktop-0722feec-a5a5-4729-842d-28ecd4c28508`, instead of the human-readable
macOS computer name.

Trusted Bonjour discovery currently validates a service by fetching
`/v1/status`, but discards the response's `desktopName` and uses the Bonjour
service instance name as the display name. Kanna intentionally uses the stable
desktop ID as that instance name, so the mobile UI receives the identifier.

## Design

Treat the validated `/v1/status` response as the source of both desktop
identity and display name:

1. Probe a trusted Bonjour endpoint's `/v1/status`.
2. Require the response's `desktopId` to match the trusted Bonjour TXT record.
3. Require `desktopName` to be a non-empty string after trimming.
4. Return the trimmed `desktopName` in the resolved endpoint.
5. Reject status responses without a usable name rather than surfacing the
   Bonjour instance identifier as a user-facing fallback.

This keeps trust anchored to the stable desktop ID while using the desktop
server's configured human-readable name for presentation.

## Alternatives Considered

- Advertise the human-readable name as the Bonjour instance name. Rejected
  because the existing instance name is a stable identity and human-readable
  names can change or collide.
- Keep using the persisted pairing name. Rejected because it can become stale
  when the Mac is renamed and account-discovered machines may not have a
  manual pairing record.
- Fall back to the Bonjour instance name when `desktopName` is missing.
  Rejected because it recreates the reported UUID leak and current supported
  servers already include `desktopName` in `/v1/status`.

## Testing

Update trusted Bonjour discovery tests so the Bonjour service name is a
desktop ID and the status response supplies a different friendly name. Assert
that the friendly status name is returned. Add coverage that a matching
desktop ID with a missing or blank `desktopName` is rejected.

Run the focused trusted Bonjour test file, then the mobile package test suite
and typecheck used by the package.
