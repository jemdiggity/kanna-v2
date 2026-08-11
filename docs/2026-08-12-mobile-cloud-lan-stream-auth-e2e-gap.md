# Mobile cloud/LAN stream authentication E2E gap (2026-08-12)

## Incident evidence

`kanna_info` identified the affected desktop as staging
`0.1.0-staging.7` on port 48121 with KSP stream version 2. The newest staging
server log was
`~/Library/Application Support/build.kanna.staging/Kanna/kanna-server_57339_2026-08-11_11-34-25.log`.
It records relay KSP tunnels, but not the in-band KSP `unauthorized` frame that
contains `invalid stream credential`; KSP currently sends that error to the
client without logging its `AuthMode` or credential branch.

The observed error is specific to the direct LAN v2 path: that endpoint uses
`RequirePairedDevice`, whereas relay KSP enters the stream as
`AlreadyAuthenticated`. The old signed-in mobile routing code could recognize
an account desktop through Bonjour without a paired-device secret, merge its
cloud task with the LAN projection, then open `/v2/stream` with no credential.
When credentials are present, mobile sends a JSON object containing exactly
`deviceId` and `deviceSecret`; the server still verifies both values against
the pairing store.

The operator's phone build and OTA `runtimeVersion`, whether the original
reproduction was explicitly tested off-LAN, whether the phone had previously
paired, whether pairing or re-pairing cleared the failure, and the credential
actually present on that phone could not be obtained. A Kanna push request for
those facts reported `noRegisteredDevices`, and the server log does not expose
them. In particular, the three pairing-claim 409 responses in the log do not
establish a successful re-pair or identify the calling phone, so this incident
must not be described as a pairing invalidated by the desktop upgrade.

## Compatibility path

For a direct non-loopback `/v1/status` request, the server now reports
`state: "pairing_required"` and omits `kspStreamVersion` unless the request
presents a currently valid paired-device credential. Pre-patch mobile already
rejects a LAN task snapshot whose status is not `running`, so its cloud task
stays on the authenticated relay without requiring a new mobile bundle.
Loopback callers, valid paired devices, and authenticated relay invokes retain
the existing `running` response and KSP v2 capability.

This is capability negotiation, not relaxed authorization. Direct `/v2/stream`
continues to use `RequirePairedDevice`: missing, stale-device, wrong-secret,
and malformed credentials are rejected. The new mobile safeguard additionally
keeps cloud-backed terminal, agent, and companion streams on relay whenever
the local mobile state has no credential, even if another LAN read produced a
projection.

## Coverage added

- The server HTTP integration test exercises anonymous, stale, invalid, valid
  paired-device, and authenticated-relay status responses.
- KSP tests exercise missing, stale, wrong-secret, malformed, and valid direct
  v2 credentials without weakening `RequirePairedDevice`.
- `cloudLanClient.test.ts` models the pre-capability-routing client (no new
  stream-route callback) consuming the revised `pairing_required` response and
  proves its terminal observer remains on the cloud/relay client. It also
  covers the new client-side safeguard for all three stream kinds.
- `lanTransport.test.ts` proves a paired client consumes `kspStreamVersion: 2`,
  opens `/v2/stream`, and sends the same paired-device credential in both HTTP
  headers and the KSP auth frame.
- `appModel.cloudFallback.test.ts` covers the composed signed-in/unpaired route
  and asserts that no LAN WebSocket is opened.

## Remaining full E2E gap

The repository still lacks one deterministic harness that combines a
Firebase-authenticated mobile account, an independently relay-authenticated
desktop, same-network Bonjour discovery, and a real non-loopback KSP socket.
The current mobile E2E fixtures cannot provision that topology or expose which
physical transport won, while staging requires operator credentials and
mutable live state.

A full E2E becomes practical when the harness can provision local cloud and
desktop identities, advertise Bonjour, and record relay versus LAN socket
selection. It should run the same account task first as unpaired (relay), then
as paired (LAN v2), and finally with a rotated or invalid secret (relay plus a
rejected direct-v2 probe).
