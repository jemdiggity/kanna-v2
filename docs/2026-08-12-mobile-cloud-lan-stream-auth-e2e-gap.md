# Mobile cloud/LAN stream authentication E2E gap (2026-08-12)

## Behavior at risk

A signed-in mobile client can discover one of its account desktops on the LAN
without having paired with that desktop. Task reads may then merge the LAN
projection into the cloud task. KSP v2 LAN streams require a paired-device
credential, while the same cloud task's relay stream is authenticated by the
relay tunnel. The mobile client must keep terminal, agent, and companion
streams on relay when the available LAN route has no paired-device credential.

## Why this is not covered end to end yet

The existing mobile E2E fixtures do not provide the combined environment this
regression needs: a Firebase-authenticated mobile account, an independently
relay-authenticated desktop, same-network Bonjour discovery, and an unpaired
mobile identity. They also do not expose which transport won hybrid routing,
so a successful task screen cannot distinguish a relay stream from an
incorrect credential-less LAN stream. Exercising this against staging would
require operator account credentials and mutable live desktop state, making it
unsuitable as a deterministic repository test.

An E2E test becomes practical when the mobile harness can provision a cloud
account and desktop identity locally (or against an isolated emulator),
advertise that desktop through Bonjour, and record whether the stream opened
through the relay tunnel or the LAN KSP endpoint. The scenario should assert
that an unpaired account device uses relay, then pair it and assert that the
same task may use authenticated LAN KSP v2.

## Narrower coverage added meanwhile

- `cloudLanClient.test.ts` verifies that all three cloud-backed KSP stream
  types stay on the cloud client when the matching LAN desktop cannot
  authenticate streams, while non-stream routing remains unchanged.
- `appModel.cloudFallback.test.ts` verifies the full mobile composition from an
  account-known Bonjour desktop with no stored device secret to the relay task
  observer, and asserts that no LAN WebSocket is opened.
- Existing server tests continue to cover strict credential rejection for
  direct KSP v2 and transport-authenticated admission for relay KSP tunnels.
