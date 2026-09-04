# Mobile custom-relay connection E2E gap (2026-09-03)

The mobile E2E relay journey cannot yet exercise the user-entered custom endpoint. Its in-process relay is exposed as task-reserved plaintext `ws://127.0.0.1:<port>`, while the product setting intentionally accepts only `wss://` endpoints with valid certificates. Appium cannot make iOS trust an ephemeral test certificate without changing native simulator/device trust state, which would test a different contract from the App Store app.

Coverage added meanwhile:

- `relaySettings.test.ts` proves `custom > environment > baked extra > production` precedence and validates the secure URL contract.
- `App.test.tsx` hydrates a stored custom endpoint through the real app model, proves the previous relay client is closed, proves a new client is created at the custom URL, and repeats the boundary when resetting to default.
- `mobileController.test.ts` keeps the logical task route fixed while advancing the relay-client generation and proves active terminal, SDK-agent, and visual-companion subscriptions close and rebind without navigation or restart. It also proves an ordinary same-generation route notification remains a no-op.
- `AccountSheet.test.tsx` covers invalid input, save, the custom indicator, and reset.
- Existing `services/relay/test/integration.test.ts` exercises real Firebase-emulator phone and desktop authentication and relay routing with entitlement enforcement off, which is the self-hosted policy.

The gap can close when the mobile relay harness can provision a locally trusted TLS certificate and expose its relay through that endpoint. The journey should enter the URL through Account settings, observe the authenticated desktop through that relay, open terminal, SDK-agent, and visual-companion streams, switch the custom endpoint and then reset to default, and assert that each active stream rebinds while the old socket closes in both directions.

## Update 2026-09-03: the journey is hidden, not queued

The user-visible custom relay endpoint control was hidden the same day it shipped (owner decision: "Tell Kanna TM to hide that feature for now. We'll come back to it."). It now exists only in `dev` builds, and shipped builds ignore any endpoint a device already stored. **The E2E journey described above is therefore not pending work** — there is no shipped user path left to cover, so nobody should pick this up as a queued gap.

The machinery, its unit coverage, and `services/relay` all stay in place. If the control is restored — `CUSTOM_RELAY_CONTROL_APP_ENVS` in `apps/mobile/src/relaySettings.ts` is the switch — this gap becomes live again exactly as written, plus one case it did not previously need: a build with the control hidden must ignore a stored endpoint and fall back to the environment default. That case is covered today by `relaySettings.test.ts`, `App.test.tsx`, `App.component.test.tsx`, and `AccountSheet.test.tsx` rather than by an E2E journey.
