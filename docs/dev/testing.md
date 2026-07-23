# Testing

## Canonical verification

Every change should pass the local gate before it is considered done:

```sh
./kd test ci     # pnpm test, Rust, then Remote E2E; sequential and fail-fast
```

Plus the static checks: `pnpm exec tsc --noEmit`, `cargo clippy`,
`cargo fmt --all` (Rust formatter is pinned by `rust-toolchain.toml`).
For focused iteration, each phase remains available as `pnpm test`,
`./kd test rust`, and `./kd test remote-e2e`.

## Test taxonomy

| Layer | Where | How to run | Needs |
|---|---|---|---|
| TS unit tests | `packages/core`, `packages/db`, `apps/desktop/src/composables/*.test.ts`, `tools/kd` | `pnpm test` (or `pnpm test` in the package dir) | — |
| Rust unit/integration | crate `tests/` dirs across `crates/` | `./kd test rust` | — |
| Daemon tests | `crates/daemon/tests/` | `./kd test rust` | spawns real daemon processes |
| CLI contract (offline) | `tests/cli-contract/tests/offline/` | `pnpm test` | — |
| CLI contract (live) | `tests/cli-contract/tests/live/` | `pnpm test:agent-cli-compat` | installed + authenticated agent CLIs; consumes quota |
| TUI fidelity | `tests/tui-fidelity/` | `pnpm test:tui-fidelity` | live/process-heavy |
| Remote E2E | `tests/remote-e2e/` | `./kd test remote-e2e` | included in `./kd test ci`; see `docs/2026-07-09-remote-e2e-layer-c-d-runbook.md` |
| Desktop E2E | `apps/desktop/tests/e2e/` | `cd apps/desktop && pnpm test:e2e` | a running worktree dev instance (below) |
| Claude-CLI Rust integration | `apps/desktop/src-tauri/tests/` | `cargo test --test agent_cli_integration -- --ignored --nocapture` | `claude` in PATH |
| Mobile Appium E2E | `apps/mobile` | `pnpm --dir apps/mobile run test:e2e:smoke` (+ `:preflight`) | local simulator; device variants are human-run |
| Shell fixture tests | `scripts/*.test.sh` | run directly | — |

### Desktop E2E setup

E2E uses W3C WebDriver via `tauri-plugin-webdriver` on port 4445 — debug builds
only (macOS WKWebView):

```sh
# Terminal 1: a worktree dev instance, started on an explicit test database
cd {repo}/.kanna-worktrees/task-{uuid}
./kd dev up --db kanna-test.db --attach

# Terminal 2:
cd apps/desktop
pnpm test:e2e
```

The `--db kanna-test.db` flag is required: the E2E preload
(`apps/desktop/tests/e2e/preload.ts`) checks the running app's database name
and refuses to run against anything that is not a test DB (the name must
contain `test`), so an instance started with the default worktree database is
rejected.

Mock suites (`tests/e2e/mock/`) cover app-launch, task lifecycle, diff view,
import, keyboard shortcuts, preferences; real suites (`tests/e2e/real/`) drive
an actual Claude session. Tests reach Vue internals via
`__vue_app__._instance.setupState`, which only exists in dev builds.

### Live suites cost real quota

`pnpm test:agent-cli-compat`, `pnpm test:tui-fidelity`, and the `--ignored`
Rust integration tests drive real agent CLIs. Run them deliberately, not as
part of routine iteration. The default Remote E2E phase is emulator-backed
and uses the scripted agent, so it is safe for the local gate.

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
