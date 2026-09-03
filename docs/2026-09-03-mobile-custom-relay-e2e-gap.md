# Mobile custom-relay connection E2E gap (2026-09-03)

The mobile E2E relay journey cannot yet exercise the user-entered custom endpoint. Its in-process relay is exposed as task-reserved plaintext `ws://127.0.0.1:<port>`, while the product setting intentionally accepts only `wss://` endpoints with valid certificates. Appium cannot make iOS trust an ephemeral test certificate without changing native simulator/device trust state, which would test a different contract from the App Store app.

Coverage added meanwhile:

- `relaySettings.test.ts` proves `custom > environment > baked extra > production` precedence and validates the secure URL contract.
- `App.test.tsx` hydrates a stored custom endpoint through the real app model, proves the previous relay client is closed, proves a new client is created at the custom URL, and repeats the boundary when resetting to default.
- `mobileController.test.ts` keeps the logical task route fixed while advancing the relay-client generation and proves active terminal, SDK-agent, and visual-companion subscriptions close and rebind without navigation or restart. It also proves an ordinary same-generation route notification remains a no-op.
- `AccountSheet.test.tsx` covers invalid input, save, the custom indicator, and reset.
- Existing `services/relay/test/integration.test.ts` exercises real Firebase-emulator phone and desktop authentication and relay routing with entitlement enforcement off, which is the self-hosted policy.

The gap can close when the mobile relay harness can provision a locally trusted TLS certificate and expose its relay through that endpoint. The journey should enter the URL through Account settings, observe the authenticated desktop through that relay, open terminal, SDK-agent, and visual-companion streams, switch the custom endpoint and then reset to default, and assert that each active stream rebinds while the old socket closes in both directions.
