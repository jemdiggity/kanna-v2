# Agent Setup refresh E2E gap

The Agent Setup screen must re-detect an agent CLI installed after Kanna starts.
The production flow crosses the Vue setup panel, the Tauri `which_binary`
command, and the server's provider resolver.

The mock desktop E2E runner currently injects
`KANNA_E2E_AGENT_CLI_VERSION_OPENCODE`, which deliberately bypasses filesystem
detection. An honest E2E would otherwise have to create or replace an
executable under the developer's real `~/.opencode/bin`, which is not safe for
an automated test.

Full coverage becomes practical when the E2E runner can give one suite an
isolated `HOME` (without moving Kanna's other per-instance state) or when binary
resolution accepts a test-only user-install root. The suite should launch Kanna
with OpenCode absent, create an executable at `.opencode/bin/opencode`, close
the setup shell, and assert that the card moves to Installed without restarting
either desktop process.

Meanwhile, narrower tests cover the wiring:

- `useAppModals.test.ts` proves closing the setup shell requests a CLI recheck.
- `MainPanel.test.ts` proves a recheck moves a newly available OpenCode CLI to
  Installed and displays its version.
- `kanna-runtime-defaults` tests prove the live user-install fallback ignores a
  non-executable file and discovers it once it becomes executable.
