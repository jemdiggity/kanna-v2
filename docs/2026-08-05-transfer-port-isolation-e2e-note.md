# Transfer port isolation E2E coverage note

2026-08-05. Written alongside giving staging its own transfer port and teaching
the task port allocator about Kanna's own listeners.

## What was broken

`DEFAULT_TRANSFER_PORT` (4455) was a flat constant, so both installed
environments told their `kanna-task-transfer` sidecar to bind the same port.
Whichever app launched second could never bind: the sidecar exited during
`TransferRuntime::spawn`, the desktop's stdout reader hit EOF, and every pending
request resolved to `transfer sidecar response channel closed for <id>`. LAN task
snapshot publishing and transfer-machine sync then failed once a second,
silently — the failure is logged, never surfaced.

This was never a regression. When staging port isolation was built (`89539fc2`,
2026-07-03) the transfer port existed only as a `"4455"` literal inside an
env-map builder, so the sweep that produced `DesktopCloudEnvironment::mobile_server_port`
did not see it. `c3ec2887` (2026-07-26) later promoted the literal to a constant
directly beneath the mobile-server-port constants but left it unscoped.

`DesktopCloudEnvironment::transfer_port` now mirrors `mobile_server_port`
(production 4455, staging 4456), and `RESERVED_INTERNAL_PORTS` collects every
port an installed Kanna binds so the per-task allocator can refuse to hand one
to a project.

## Why no E2E

**The collision itself is not reproducible in a test harness.** It needs two
*installed* app bundles at their real bundle identifiers (`build.kanna` and
`build.kanna.staging`) running at once, because the port is chosen from the
bundle identifier and only release builds resolve an environment at all —
`desktop_cloud_environment_for_bundle_identifier` returns `None` under
`debug_assertions`. The E2E harness runs debug builds and sets
`KANNA_TRANSFER_PORT` explicitly (`apps/desktop/tests/e2e/run.ts`), which is the
override path, not the default path under test. Nothing short of installing two
signed bundles exercises it.

What would make it testable is a way to run the desktop under a forced bundle
identity without packaging — the `build_transfer_sidecar_env_for_bundle_identifier`
seam already exists in Rust, so this is a harness question, not a product one.

**The allocator half is covered at its real boundary.** `claim_task_ports` is an
HTTP route over SQLite, and the route test drives the axum router and the
database, so the wiring under test is the wiring that ships.

## Coverage added

- `crates/runtime-defaults/src/lib.rs` — the two installed environments carry
  distinct transfer ports; `transfer_port_for_bundle_identifier` resolves from a
  release bundle id and declines for debug builds; `RESERVED_INTERNAL_PORTS`
  contains every installed listener and holds no duplicates.
- `apps/desktop/src-tauri/src/transfer_sidecar.rs` — the sidecar env gives each
  installed environment its own listen port, an explicit `KANNA_TRANSFER_PORT`
  still wins, and development builds fall back to the shared default.
- `apps/desktop/src-tauri/src/commands/mobile/config.rs` — `server.toml` is
  written with the environment's transfer port, and a config carrying the *other*
  environment's port is rejected by `server_config_matches_runtime`, so a stale
  file forces a rewrite instead of reinstating the collision.
- `crates/kanna-server/src/internal_ports.rs` — the reserved set covers every
  installed listener and does not disturb ports the caller already marked.
- `crates/kanna-server/src/http_api/tests/core_routes.rs` and
  `task_creator/tests/core.rs` — both allocators, given a base port sitting
  directly below one of Kanna's listeners, skip past it rather than handing it out.

## Note for repo authors

`.kanna/config.json` in this repo sets `reserved_port_offsets: [0, 1]`, which
already reserved 4455/4456 and 48120/48121 for its own declared bases — so
Kanna's own task allocations do not change. The point of `RESERVED_INTERNAL_PORTS`
is every *other* project, which has no reason to know Kanna's ports exist.
