# Testing

## Canonical verification

Every change should pass this before it is considered done:

```sh
./kd test all    # runs every lane below in order, failing fast
```

It composes the individual lanes, which you can still run one at a time:

```sh
pnpm test        # turbo-run JS/TS suites across the workspace
./kd test rust   # Rust workspace tests
```

Plus the static checks: `pnpm exec tsc --noEmit`, `cargo clippy`,
`cargo fmt --all` (Rust formatter is pinned by `rust-toolchain.toml`).

## Test taxonomy

| Layer | Where | How to run | Needs |
|---|---|---|---|
| TS unit tests | `packages/core`, `packages/db`, `apps/desktop/src/composables/*.test.ts`, `tools/kd` | `pnpm test` (or `pnpm test` in the package dir) | — |
| Rust unit/integration | crate `tests/` dirs across `crates/` | `./kd test rust` | — |
| Daemon tests | `crates/daemon/tests/` | `./kd test rust` | spawns real daemon processes |
| CLI contract (offline) | `tests/cli-contract/tests/offline/` | `pnpm test` | — |
| CLI contract (live) | `tests/cli-contract/tests/live/` | `pnpm test:agent-cli-compat` | installed + authenticated agent CLIs; consumes quota. The TUI-driven pins also need `/usr/bin/python3` (it hosts the PTY — see `helpers/pty.ts`). Everything skips, rather than fails, when a CLI or the PTY is unavailable |
| TUI fidelity | `tests/tui-fidelity/` | `pnpm test:tui-fidelity` | live/process-heavy |
| Remote E2E | `tests/remote-e2e/` | `pnpm test:remote-e2e` | see `docs/2026-07-09-remote-e2e-layer-c-d-runbook.md` |
| Desktop E2E (mock) | `apps/desktop/tests/e2e/mock/` | `cd apps/desktop && pnpm test:e2e` | macOS debug build |
| Desktop real E2E (unattended) | `apps/desktop/tests/e2e/real/` | `./kd test desktop-e2e` | macOS; OpenCode free model configured by the runner |
| Desktop real E2E (operator) | files listed in `apps/desktop/tests/e2e/realTiers.ts` | `./kd test desktop-e2e-operator` | credentials and/or an explicit human operator; see below |
| Claude-CLI Rust integration | `apps/desktop/src-tauri/tests/` | `cargo test --test agent_cli_integration -- --ignored --nocapture` | `claude` in PATH |
| Mobile Appium E2E | `apps/mobile` | `pnpm --dir apps/mobile run test:e2e:smoke` (+ `:preflight`) | local simulator; device variants are human-run |
| Shell fixture tests | `scripts/*.test.sh` | run directly | — |

### Desktop E2E tiers

E2E uses W3C WebDriver via `tauri-plugin-webdriver` — debug builds only (macOS
WKWebView). The runner starts isolated app instances, databases, daemons,
Firebase emulators, and relay processes as required by each file. It allocates
and claims each port for the lifetime of the run, so sequential and parallel
runners do not share a listener.

The real suite has two exhaustive tiers declared in
`apps/desktop/tests/e2e/realTiers.ts`; a unit test fails if a real test file is
unclassified or appears in both:

| Tier | Command | What it proves | When it runs |
|---|---|---|---|
| Unattended | `./kd test desktop-e2e` | Real desktop UI ↔ server ↔ daemon/PTY, git/worktree, local/LAN/relay, Firebase-emulator, and companion-browser wiring. Live agent cases use the runner's OpenCode free model. | Nightly and pre-release; also before landing changes to these boundaries. It is deliberately **not** part of `./kd test all`. Adding that merge-gate cost is a separate product decision. |
| Operator | `./kd test desktop-e2e-operator` | Deployed-cloud credential smoke files and retained provider-specific Codex/Claude files. | Only when an operator intentionally supplies the required account/credential context. Missing credential/provider context skips the affected file. Never use this as an unattended Claude lane. |

The operator tier currently contains:

- `cloud-prod-smoke` and `cloud-relay-desktop-auth`: deployed-cloud credentials;
- `sdk-lifecycle-codex` and `stage-advance-sdk-codex`: Codex account/quota and provider-specific SDK behavior;
- `local-transfer-claude-transcript` and `themed-claude-session`: retained Claude-specific coverage. The default runner does not drive Claude programmatically; OpenCode continuity and terminal-theme coverage remain in the unattended tier.

Run a single file through the harness, never through bare Vitest:

```sh
pnpm --dir apps/desktop test:e2e real/pty-session.test.ts
```

When debugging against an already-running desktop instead of the harness, keep
the preload's explicit test-database guard enabled:

```sh
KANNA_E2E_TEST_SQL=1 ./kd dev up --db kanna-test.db
```

Mock suites (`tests/e2e/mock/`) cover app-launch, task lifecycle, diff view,
import, keyboard shortcuts, preferences. Real suites cover the process
boundaries listed above. Tests reach Vue internals via
`__vue_app__._instance.setupState`, which only exists in dev builds.

### Live suites cost real quota

`pnpm test:agent-cli-compat`, `pnpm test:remote-e2e`, `pnpm test:tui-fidelity`,
and the `--ignored` Rust integration tests drive real agent CLIs. Run them
deliberately, not as part of routine iteration.

## The E2E coverage expectation

Any behavior that crosses component or system boundaries (UI flows,
client↔server interactions, daemon/PTY/git/filesystem behavior, persistence and
reconnect, async coordination) must add or update at least one E2E test.

If that isn't feasible yet, the change must land with a dated note in `docs/`
(`YYYY-MM-DD-<topic>-e2e-gap.md` or `…-e2e-note.md`) documenting why it isn't
testable end-to-end, what would make it testable, and what narrower tests were
added meanwhile. Browse the existing notes in `docs/` for the expected shape.

## Manual QA gates

Human-run gates and runbooks live in [`docs/testing/`](../testing/) — notably
the mobile production QA gate required before TestFlight external testing or
App Store submission.
