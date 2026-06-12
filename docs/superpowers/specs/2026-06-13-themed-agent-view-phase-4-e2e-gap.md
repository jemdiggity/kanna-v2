# Themed Agent View Phase 4 E2E Gap

Phase 4 adds relay tunnel transport and routes remote desktop/mobile agent streams through KSP. I did not add a desktop E2E for the two-instance relay streaming path in this change because the existing `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts` harness exercises the legacy relay sync vocabulary and does not yet stand up a paired byte-blind relay tunnel plus tunneled KSP `observeTaskAgent` flow between two desktop instances.

To make this testable end to end, the real E2E harness needs helpers that:

- start a local relay with tunnel mode enabled,
- register one desktop instance as the owner control socket,
- launch a second desktop/mobile client with a relay tunnel stream credential,
- create or seed an agent task on the owner, and
- assert themed `agent_event` replay and live events over the tunneled KSP connection.

Narrower coverage added in the meantime:

- `services/relay/test/integration.test.ts` pairs two sockets through a local relay and verifies byte-blind text/binary splicing plus offline tunnel rejection.
- `crates/kanna-server/src/ksp.rs` covers tunnel KSP auth requirements and shared request dispatch.
- `crates/kanna-server/src/relay_client.rs` covers tunnel auth message construction.
- `packages/stream-client/src/stream-client.test.ts` covers relay tunnel prelude before KSP auth and queued frame flushing.
- `apps/desktop/src/services/desktopRelayTerminal.test.ts` covers desktop remote terminal over KSP-through-tunnel.
- `apps/mobile/src/lib/transports/remoteTransport.test.ts` covers remote agent observer delegation for mobile cloud tasks.
