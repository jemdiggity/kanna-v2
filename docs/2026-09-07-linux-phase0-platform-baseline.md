# Linux Phase 0: platform baseline, toolchain, and build evidence

Date: 2026-09-07

Task: `81ab28f1` (plan-build-review dogfood). Reference:
[Linux desktop support](specs/linux-desktop-support.md), Phase 0
"Bound the platform".

Companion: [identity, PTY, and launcher spikes](2026-09-07-linux-identity-pty-launcher-spike.md).

This document records what was **measured** on a real Linux guest. Phase 0 is a
measurement phase: it commits the smallest build-config changes needed to run
the spikes and the evidence they produced. It implements no Linux daemon
identity backend, no Linux data paths, no shell policy, and no packaging.
Nothing here moves orchestration into the GUI or changes a daemon/server
contract.

Every command below was run over `ssh kanna-linux-vm` against the guest
described in §1, from a snapshot of branch `task-81ab28f1-2` at
`1af9c994b` plus the §4 changes.

## 1. The VM

Discovered locally on the Mac Studio: the guest is NAT'd behind the
hypervisor's shared network (`bridge100`, host side `192.168.64.1`), which is
why it never answered mDNS from the LAN. Its lease is in
`/var/db/dhcpd_leases`.

| Fact | Value |
| --- | --- |
| Hypervisor | UTM, QEMU aarch64 with the Apple hypervisor, machine `virt-10.0` |
| VM | name `Linux`, UUID `AFA4B3BF-1874-4CB2-AACD-82C47B8C2EC5` |
| Address | `192.168.64.2` (host bridge `192.168.64.1`), shared/NAT, no port forwards |
| Distro | Ubuntu 26.04.1 LTS ("resolute") |
| Kernel | `7.0.0-31-generic`, aarch64 |
| glibc | 2.43 (`Ubuntu GLIBC 2.43-2ubuntu2.3`) |
| systemd | 259 |
| Desktop | GNOME 50 on Wayland, gdm3 |
| Login shell | `/bin/bash`; `/bin/sh` is `dash`; **no `zsh`** |
| Coreutils | Rust uutils (`/usr/lib/cargo/bin/coreutils/*`) |
| CPU / RAM / disk | 8 vCPU, 15 GiB RAM, one 64 GB virtio disk (62.9 GB root) |
| Hardening | `kernel.yama.ptrace_scope=1`, `fs.protected_regular=2`, `fs.protected_fifos=1`, `fs.protected_symlinks=1`, `fs.protected_hardlinks=1` |
| Limits | `kernel.pid_max=4194304`, `kernel.pty.max=4096` |
| Clock | `America/Edmonton`; `NTPSynchronized=no` (wall clock is nonetheless correct; `systemd-timesyncd` is not a unit on this image) |

### Access

A dedicated keypair `~/.ssh/kanna-linux-vm_ed25519` was generated on the Mac
Studio and installed in the guest's `authorized_keys`; `~/.ssh/config` defines
the alias `kanna-linux-vm`. `ssh -o BatchMode=yes kanna-linux-vm` succeeds
without a password. `sshd` is socket-activated (`ssh.socket` enabled), so it
survives reboot. `sudo` still requires the password — **no NOPASSWD rule was
added, and none should be.**

`utmctl ip-address <uuid>` works now that `qemu-guest-agent` is installed.

Do not drive the guest through the UTM console window: UTM drops fast synthetic
keystrokes and captures Ctrl+Alt. Use SSH.

## 2. What was installed in the guest

Everything below is either an apt package or a user-local tarball under
`$HOME`. Nothing was configured in a way that constrains later phases. Two
system-level changes are worth calling out explicitly:

- `kernel.yama.ptrace_scope` was temporarily set to 2 to measure its effect and
  **restored to 1** (its original value).
- `loginctl enable-linger jeremy` was enabled to measure user-unit lifetime and
  **left enabled**, because Phase 1's headless worker needs it. Undo with
  `sudo loginctl disable-linger jeremy` if you want the original state.
- `zsh` was installed after the first test pass — see below.

### apt

`openssh-server`, `qemu-guest-agent` (installed before this stage, to reach the
VM at all), then:

```
build-essential git curl pkg-config tmux file patchelf xz-utils
libc++-dev libc++abi-dev
libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
libssl-dev        # added later; see §5
```

Notable versions: `cc (Ubuntu 15.2.0-16ubuntu1) 15.2.0`, `git 2.53.0`,
`tmux 3.6`, `gtk+-3.0 3.24.52`, `webkit2gtk-4.1 2.52.6`,
`libssl-dev 3.5.5-1ubuntu3.5` (OpenSSL 3.5.5).

`libc++1` and `libc++abi1` were **not** present on the base image; apt pulled
them in as automatic dependencies of `libc++-dev`. That matters for packaging —
see §6.

### User-local (not apt)

| Tool | Version | Location | Why this version |
| --- | --- | --- | --- |
| rustup + toolchain | `1.93.1` (rustc `01f6ddf75`), `rustfmt 1.8.0`, `clippy 0.1.93` | `~/.cargo` | `rust-toolchain.toml` |
| Node | `v24.15.0` | `~/.local/node` | repo `.nvmrc` |
| pnpm | `11.0.8` via corepack | `~/.local/bin` | root `package.json` `packageManager` |
| Zig | `0.15.2` (`zig-aarch64-linux-0.15.2.tar.xz`) | `~/.local/zig`, symlinked to `~/.local/bin/zig` | `MODULE.bazel` `zig.toolchain`, and `libghostty-vt-sys/build.rs` invokes bare `zig` |
| Bazelisk | `v1.29.0` → Bazel `9.0.1` from `.bazelversion` | `~/.local/bin/bazel` | `.bazelversion` |

`zsh` was deliberately **not** installed for the first test pass, so the suites
that hardcode `/bin/zsh` would fail visibly (§7, §9). It was then installed
(`zsh 5.9-8ubuntu3`) as a documented second pass for §9.1. **A clean Ubuntu
machine has no `zsh`** — that is the whole point of the shell-policy decision,
and the VM is no longer representative of one in that respect.

### What a fresh VM needs

1. `openssh-server`, `qemu-guest-agent`; install an SSH key.
2. The apt list above, including `libssl-dev`.
3. rustup with the `rust-toolchain.toml` pin; Node from `.nvmrc`; corepack
   pnpm; the Zig 0.15.2 linux-aarch64 tarball on `PATH`; bazelisk.
   Leave `zsh` off if you want to reproduce the clean-machine shell failures.
4. `pnpm install --frozen-lockfile` (33.6 s here).
5. Source: transfer the tree over SSH. **If you use `tar` from macOS, strip
   AppleDouble files** (`find . -name '._*' -delete`) — macOS `tar` writes
   extended attributes as `._*` siblings, and `tauri_build` fails reading
   `capabilities/._default.json` as invalid UTF-8. That is a transfer artifact,
   not a Linux finding; the first `cargo check -p kanna-desktop` run here hit
   it and was re-run after cleaning.

## 3. Headline result

All six pinned sidecars build natively on Ubuntu 26.04 aarch64 with the pinned
Rust 1.93.1 and Zig 0.15.2 toolchains, from unmodified crate sources. The
`kanna-daemon` binary runs, and fails exactly where the spec predicted: at
`SuccessorAuthorizer::capture()`, because `proc_info`'s non-macOS `process_info`
is a stub. See §8 and the companion document.

## 4. Repository changes made in this phase

Two, both minimal and cfg/platform-gated:

- `crates/runtime-defaults/src/lib.rs` — `current_target_triple()` gained
  `aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu` arms. Without it
  every Linux sidecar is looked for as `kanna-daemon-unknown-target` and is
  invisible to `sidecar_candidates`. The `unknown-target` fallback is retained
  for every other target, and now also covers macOS/Linux on an unsupported
  architecture instead of failing to compile. Covered by a new cfg-gated unit
  test `current_target_triple_matches_the_rust_host_triple`.
- `tools/kd/src/runtime/setup.ts` — `checkSetupPrerequisites` takes the
  platform (defaulting to `process.platform`) and runs the `xcode-select -p`
  check only on macOS. On Linux it checks `cc --version` and
  `pkg-config --exists gtk+-3.0 webkit2gtk-4.1` instead, with an apt install
  hint. Covered by `tools/kd/tests/setup.test.ts`.

Verified end to end on the guest:

```
$ ./kd setup --check
[ { "name": "cc",        "ok": true, "message": "cc (Ubuntu 15.2.0-16ubuntu1) 15.2.0" },
  { "name": "webkitgtk", "ok": true, "message": "gtk+-3.0 and webkit2gtk-4.1 present" },
  { "name": "rust", ... }, { "name": "cargo", ... }, { "name": "node", ... },
  { "name": "pnpm", ... }, { "name": "bazel", "message": "... Build label: 9.0.1 ..." },
  { "name": "git", ... }, { "name": "zig", "message": "0.15.2" },
  { "name": "tmux", ... }, { "name": "node_modules", "ok": true } ]
```

Deliberately **not** changed in Phase 0 (each is later-phase scope):
`tools/kd/src/context.ts` macOS paths, `MODULE.bazel`
`supported_platform_triples`, the `/bin/zsh` invocations, and the `native-tls`
dependency (§6).

## 5. Build spike: the six sidecars

`cargo build --target aarch64-unknown-linux-gnu --manifest-path <manifest>`,
debug profile, cold `.build/`.

| Sidecar | First attempt | After `libssl-dev` | Wall time |
| --- | --- | --- | --- |
| `crates/daemon` | ✅ exit 0 | — | 180 s (includes the Zig/Ghostty build) |
| `crates/kanna-cli` | ❌ exit 101 | ✅ exit 0 | 6 s → 16 s |
| `crates/kanna-mcp` | ❌ exit 101 | ✅ exit 0 | 2 s → 4 s |
| `crates/kanna-server` | ❌ exit 101 | ✅ exit 0 | 5 s → 53 s |
| `crates/task-transfer` | ✅ exit 0 | — | 24 s |
| `packages/terminal-recovery` | ✅ exit 0 | — | 4 s |

The three failures were one cause:

```
Could not find openssl via pkg-config: Package 'openssl' not found
The system library `openssl` required by crate `openssl-sys` was not found.
```

`cargo tree -i openssl-sys` gives the chain:
`kanna-cli → reqwest (default features) → default-tls → native-tls → openssl-sys`.
`kanna-server` reaches it through `tokio-tungstenite = { features = ["native-tls"] }`
even though its `reqwest` is already `rustls-tls`. On macOS `native-tls` binds
Security.framework, so none of this is visible; the vendored `openssl-src` in
`Cargo.lock` comes from the desktop crate's `git2 vendored-openssl` and does not
cover these three. Installing `libssl-dev` (a declared OS runtime library) fixed
all three without touching a crate.

The **pinned Zig 0.15.2 + Ghostty fork `665a03f3` builds natively on Linux
aarch64** — `zig build -Demit-lib-vt` ran unmodified for all four
`libghostty-vt-sys` consumers. The `rules-zig` macOS CLT SDK patch
(`tools/bazel/rules-zig-0.15.2-macos-clt-sdk.patch`) stayed scoped to
`aarch64-macos` and was never consulted.

### Linked libraries (`readelf -d`, debug binaries)

| Sidecar | Size | `NEEDED` |
| --- | --- | --- |
| `kanna-daemon` | 100 MB | `libc++.so.1`, `libc++abi.so.1`, `libgcc_s.so.1`, `libm.so.6`, `libc.so.6` |
| `kanna-cli` | 61 MB | `libssl.so.3`, `libcrypto.so.3`, `libgcc_s.so.1`, `libc.so.6` |
| `kanna-mcp` | 60 MB | `libssl.so.3`, `libcrypto.so.3`, `libgcc_s.so.1`, `libc.so.6` |
| `kanna-server` | 315 MB | `libc++.so.1`, `libc++abi.so.1`, `libssl.so.3`, `libcrypto.so.3`, `libgcc_s.so.1`, `libm.so.6`, `libc.so.6` |
| `kanna-task-transfer` | 105 MB | `libc++.so.1`, `libc++abi.so.1`, `libgcc_s.so.1`, `libm.so.6`, `libc.so.6` |
| `kanna-terminal-recovery` | 20 MB | `libc++.so.1`, `libc++abi.so.1`, `libgcc_s.so.1`, `libc.so.6` |

No `RUNPATH`/`RPATH` on any binary. All are PIE, `for GNU/Linux 3.7.0`.

Highest versioned symbol requirements: `GLIBC_2.39` (daemon, server),
`GLIBC_2.34` (cli). SQLite is bundled as expected — no `libsqlite3` anywhere.

## 6. Dependency-policy evidence

Two Kanna-owned choices leak into the OS runtime surface on Linux:

1. **`libc++1` / `libc++abi1`** — four of six sidecars link LLVM's C++ runtime
   because Zig links Ghostty that way. These packages are **not** on a base
   Ubuntu 26.04 image; apt installed them as automatic dependencies. A deb
   would have to declare them, or the Zig link would have to change (static
   libc++, or `libstdc++`). That is a real choice, not a formality: most Linux
   debs do not depend on `libc++1`.
2. **`libssl3t64`** — required only because two crates still route TLS through
   `native-tls`. `kanna-server` already uses `rustls-tls` for `reqwest`;
   `tokio-tungstenite` is the remaining consumer there, and `kanna-cli` /
   `kanna-mcp` simply take `reqwest`'s default features.

`ldconfig`/`dpkg -S` mapping for a deb's `Depends:`:

| soname | package |
| --- | --- |
| `libc++.so.1` | `libc++1` |
| `libc++abi.so.1` | `libc++abi1` |
| `libssl.so.3` | `libssl3t64` |

The measured glibc floor is **2.39**, not 2.43: these binaries would run on
Ubuntu 24.04 (glibc 2.39) but not 22.04 (2.35). That is a stricter statement
than "built on 26.04", and it is what a baseline decision should be made
against.

**Owner decision, with the evidence now in hand:** accept "deb declaring OS
runtime libraries (`libc++1`, `libc++abi1`, `libssl3t64`, plus the Tauri GUI
stack), with Kanna-owned sidecars, resources and definitions bundled; agent CLIs
and repository toolchains user-managed" — or reject `libssl` specifically and
schedule the `rustls` move. Phase 0 deliberately did not make that change.

## 7. Test-suite spike

See §9 for per-crate results. Static classification of the macOS-shaped
coverage that a Linux port must replace:

| Class | Where | Count |
| --- | --- | --- |
| (a) whole file macOS-gated | `crates/daemon/tests/handoff.rs` | 29 tests |
| (a) whole file macOS-gated | `crates/kanna-server/tests/bonjour_multi_process.rs` | 1 test |
| (a) unit tests behind `#[cfg(target_os = "macos")]` | `daemon/src/agent.rs` (7), `daemon/src/pty.rs` (6), `daemon/tests/reconnect.rs` (1) | 14 |
| (b) hardcoded `/bin/zsh` in product code | `kanna-server/src/workspace_commands.rs:402`, `kanna-server/src/task_creator/environment.rs:407` | 2 call sites |
| (b) hardcoded `/bin/zsh` in fixtures/tests | `task_creator/mod.rs`, `task_creator/tests/setup.rs`, `daemon/src/pty.rs:1424`, `daemon/src/successor_auth.rs`, `kanna-agent-protocol` fixtures, desktop E2E | ~20 sites |
| (c) identity-dependent | anything that starts a daemon: `startup.rs:186/194` aborts because `proc_info`'s Linux `process_info` is a stub | 113 failing `kanna-daemon` tests + 1 in `kanna-server` (§9.1) |
| (d) PTY-boundary premises | `daemon/tests/reconnect.rs` receipt/split tests around the macOS 1,022-byte boundary | see companion §6 |

## 8. Running the Linux daemon

```
$ .build/aarch64-unknown-linux-gnu/debug/kanna-daemon --version
kanna-daemon 0.2.0 (main @ 2d3bb9c)

$ .build/aarch64-unknown-linux-gnu/debug/kanna-daemon
INFO  [detection] using bundled agent-status rules; no override at
      /home/jeremy/Library/Application Support/Kanna/detection-rules.json
ERROR [handoff] refusing to start without successor trust root:
      sending daemon process 19154 is not live
kanna-daemon: could not capture launcher trust root: sending daemon process 19154 is not live
```

Two facts in five lines:

- `SuccessorAuthorizer::capture()` calls `live_process(lookup, sender_pid)`,
  which calls `proc_info::process_info` — `None` on Linux — so the daemon aborts
  on **its own pid**, before it ever looks at a launcher. The identity backend
  is the first blocker, exactly as the spec says.
- The daemon resolved its data directory to
  `/home/jeremy/Library/Application Support/Kanna/`. `runtime-defaults`
  constructs macOS application-support paths unconditionally. Phase 1 needs one
  coherent Linux path contract across `runtime-defaults`,
  `tools/kd/src/context.ts`, and the server.

## 9. Per-crate `cargo test` on Linux

`cargo test -p <crate> --target aarch64-unknown-linux-gnu`, first pass, on a
machine with **no `zsh`** (deliberately — see §2):

| Crate | Exit | Result |
| --- | --- | --- |
| `kanna-runtime-defaults` | 0 | all pass, including the new triple assertion |
| `kanna-daemon` | 101 | lib: **313 passed, 1 failed** |
| `kanna-server` | 101 | **1326 passed, 22 failed** |
| `kanna-agent-protocol` | 0 | all pass |
| `kanna-cli` | 101 | 105 passed, 1 failed |
| `kanna-mcp` | 101 | 33 + 2 + 33 passed, 1 failed |
| `kanna-task-transfer` | 0 | all pass |
| `kanna-terminal-recovery` | 0 | all pass |
| `kanna-tool-catalog` | 0 | all pass |

`cargo test` stops at the first failing target, so the daemon's integration
targets (`reconnect.rs`, `agent_sessions.rs`, …) did not run in this pass; a
`--no-fail-fast` pass follows in §9.1.

### The failures, by class

**(c) identity-dependent — 1 in `kanna-daemon`:**

```
pty::tests::take_reap_token_is_one_shot_and_blocks_later_signals
  panicked at crates/daemon/src/pty.rs:1953:
  owned PTY reap tokens must retain their start-time identity
```

`start.is_some()` is false because `proc_info::process_info` is the Linux stub.
This is the identity gap surfacing in a unit test rather than at startup, and it
is the whole `kanna-daemon` lib delta: 313 of 314 pass.

**(b) hardcoded `/bin/zsh` — the bulk of the 22 in `kanna-server`.** The
signature is `failed to run workspace setup: No such file or directory
(os error 2)`, from `workspace_commands.rs:402`
(`Command::new("/bin/zsh")`) and `task_creator/environment.rs:407`. Affected
groups: `workspace_commands::tests` (5), `task_creator::tests::{setup,stage,spawn,core}`
(11), `http_api::tests::{actions,revision_status}` (3, via stage advance running
setup), plus `human_control::tests::idle_unauthorized_connection_is_rejected_before_the_request_read`
(1), which is not obviously shell-related and needs its own look in Phase 1.
§9.1 re-runs this suite **with `zsh` installed** to separate the classes exactly.

**(e) environment artifact, not a Linux finding — 1 each in `kanna-cli` and
`kanna-mcp`:**

```
kanna-server binary is missing at /home/jeremy/kanna/.build/debug/kanna-server;
this test drives the real server, so run `cargo test --workspace` or
`cargo build -p kanna-server` first
```

The spikes built with `--target`, which stages under
`.build/<triple>/debug/`; this fixture looks in the host-triple-less
`.build/debug/`. Not a portability problem.

### 9.1 Second pass: `--no-fail-fast`, with `zsh` installed

`zsh 5.9-8ubuntu3` was installed after the first pass (documented in §2 as a
deliberate second pass — a clean Ubuntu machine has none) and
`kanna-daemon` / `kanna-server` were re-run with `--no-fail-fast` so every
target executes.

#### `kanna-daemon` — 651 pass, 113 fail, and **every failure is the identity stub**

| Target | Result |
| --- | --- |
| lib | 313 passed, 1 failed |
| bin `kanna-daemon` | 326 passed, 6 failed |
| `build_git_identity` | 3 passed |
| `fixture_isolation` | 6 passed |
| `agent_sessions` | **0 passed, 14 failed** |
| `detection_rules` | **0 passed, 5 failed** |
| `reconnect` | **0 passed, 73 failed**, 2 ignored |
| `recovery_service` | **0 passed, 13 failed** |
| `worktree_isolation` | **0 passed, 1 failed** |
| `handoff` | compiled out (macOS-gated file, 29 tests) |

The seven unit-level failures are each a direct read of a `proc_info` stub:

| Test | Stub it hits |
| --- | --- |
| `pty::tests::take_reap_token_is_one_shot_and_blocks_later_signals` | `process_info` → no `StartTime` for the reap token |
| `agent_runtime::adoption::tests::an_authentic_bundle_passes` | `pipe_end_belongs_to` → `false` |
| `agent_runtime::adoption::tests::a_bundle_with_a_forged_stderr_is_rejected_whole` | `pipe_end_belongs_to` → `false` |
| `tests::attempt_handoff_keeps_unverified_reused_pids_unauthenticated` | `process_info` |
| `tests::forged_agent_handoff_cannot_target_unrelated_processes` | `process_info` |
| `tests::legacy_handoff_without_identity_keeps_live_agents_killable` | `process_info` |
| (+1 duplicate of the reap-token test in the bin target) | |

**All 106 integration failures are one blocker, not 106.** Every one of them is
the harness failing to reach a daemon that refused to start:

```
ERROR [handoff] refusing to start without successor trust root:
      sending daemon process 87941 is not live
kanna-daemon: could not capture launcher trust root: …
…
panicked at crates/daemon/tests/agent_sessions.rs:79:
failed to connect: Os { code: 2, kind: NotFound }
```

So the daemon's Linux test picture is: **one fix — a real `proc_info` backend —
unblocks 113 failing tests**, after which the actual behavioural porting of the
29 macOS-gated `handoff.rs` tests and the PTY receipt premises begins.

#### A leaked detached descendant — the teardown sweep is blind on Linux

The `--no-fail-fast` run wedged partway through: `cargo` had exited, but the
pipeline's `grep` never saw EOF. Locating the holder with the same
`/proc/<pid>/fd` technique as the pipe spike found three `sleep 300` processes
from the daemon suite, reparented to init, still holding the harness's stdout
and stderr:

```
pid=79035 state=S ppid=1 pgrp=79034 session=79034 tty_nr=0
  exe=/usr/lib/cargo/bin/coreutils/sleep  cwd=/home/jeremy/kanna/crates/daemon
  SigIgn: 0000000000004007      # SIGTERM ignored
```

Two died on `SIGTERM`; the third — a deliberate SIGTERM-ignoring escapee
fixture — needed `SIGKILL`. This is the spec's "detached descendant teardown"
requirement failing concretely: the session sweep needs `all_process_info()`
(empty vec on Linux) and `slave_device_of_master()` (`None` on Linux) to find
processes that have left the process group, so on Linux it finds nothing and the
survivors outlive the run. Any Linux CI lane will hang on this until the
identity backend exists.

#### `kanna-server` with `zsh` installed

Installing `zsh` took `kanna-server` from **22 failures to 7**: 1341 passed,
7 failed, with every other target green. So 15 of the 22 were purely
`Command::new("/bin/zsh")` finding nothing.

The remaining 7, each run individually to get its message:

| Test | Cause | Class |
| --- | --- | --- |
| `human_control::tests::idle_unauthorized_connection_is_rejected_before_the_request_read` | the test itself calls `kanna_daemon::proc_info::process_info(pid).unwrap()` (`human_control.rs:310`) | (c) identity stub |
| `task_creator::tests::core::a_teardown_spawn_names_no_agent_cli_to_probe` | `None of the configured agent providers are available: codex` | (e) no agent CLIs on the guest |
| `task_creator::tests::core::prepare_task_prefers_explicit_then_repo_then_agent_definition_over_default_provider_setting` | `…are available: opencode` | (e) no agent CLIs on the guest |
| `task_creator::tests::setup::initial_pty_task_streams_setup_before_starting_setup_created_provider` | see below | **(b) shell policy** |
| `task_creator::tests::setup::stage_fork_runs_repo_setup_before_resolving_pty_provider` | see below | **(b) shell policy** |
| `http_api::tests::actions::advance_stage_route_records_stage_run_for_spawned_next_task` | `fake daemon connection closed before the expected command` | **unclassified** |
| `http_api::tests::revision_status::review_prompt_receives_the_implementer_result_while_prev_result_keeps_the_post_result` | route returns 500 instead of 200, with no cause in the output | **unclassified** |

#### Installing `zsh` is not the same as having a usable `zsh`

The two remaining shell failures are worth their own note, because they are the
strongest argument in this document for making a deliberate shell decision
rather than adding a dependency:

```
PTY bootstrap did not finish: ␛[H␛[2J␛[3J
This is the Z Shell configuration function for new users, zsh-newuser-install.
You are seeing this message because you have no zsh startup files…
```

A freshly installed `zsh` with no `~/.zshrc` runs an **interactive first-run
configuration wizard** on every login shell, clears the screen, and waits for a
keypress. Kanna's PTY bootstrap sees that instead of its setup output. So on a
clean Linux machine the shell assumption fails twice over: `/bin/zsh` is absent,
and installing it produces a shell that blocks on a wizard until someone creates
a startup file. The supported-shell policy has to name a shell that is present
and non-interactive out of the box — `/bin/sh`, `bash`, or the user's
`$SHELL` with an explicit non-interactive invocation — not simply move the
hardcoded path.

The two unclassified `http_api` failures are recorded as unclassified on
purpose: Phase 0 did not determine whether they are Linux-specific, timing, or
pre-existing. Phase 1 should reproduce them on macOS before assuming either.

### 9.2 `./kd build sidecars` works on Linux

```
$ ./kd build sidecars
RESULT kd_build_sidecars exit=0
$ ls apps/desktop/src-tauri/binaries
kanna-cli-aarch64-unknown-linux-gnu       kanna-server-aarch64-unknown-linux-gnu
kanna-daemon-aarch64-unknown-linux-gnu    kanna-task-transfer-aarch64-unknown-linux-gnu
kanna-mcp-aarch64-unknown-linux-gnu       kanna-terminal-recovery-aarch64-unknown-linux-gnu
```

This is the end-to-end proof of the `current_target_triple()` change in §4:
`kd` derived the Linux host triple, built through `cargo`, and staged all six
sidecars under the correct triple-suffixed names. `kd`'s tmux identity, port
derivation, and `.build/` layout all worked unmodified.

`./kd doctor` exits 1 for one reason only — the `sqlite3` CLI is not installed
on the guest. Everything else (git, pnpm, tmux, rustc, cargo) is found. That is
a missing package on this VM, not a `kd` portability defect.

## 10. Desktop crate, clippy, and Bazel

### 10.1 The Tauri desktop crate compiles against WebKitGTK 2.52

```
$ cargo check -p kanna-desktop --target aarch64-unknown-linux-gnu
  … Checking tauri v2.10.3, tauri-runtime-wry v2.10.1, tauri-plugin-{fs,shell,
    process,updater,webdriver,opener,dialog}, git2 v0.19.0, tokio-tungstenite …
warning: function `parse_lsof_pids` is never used
   --> apps/desktop/src-tauri/src/commands/mobile/process.rs:169:4
    Finished `dev` profile in 11.46s
RESULT desktop_check exit=0
```

This is a better result than the plan expected. The macOS-only dependency block
and `src/macos.rs` cfg out cleanly; the only diagnostic is one dead-code
warning for a macOS-only `lsof` helper. Notably `tauri-plugin-webdriver 0.2.1`
itself compiles on Linux — that does not make the E2E lane work (it still needs
a real Linux app launch and a WebKit WebDriver), but it removes one assumed
blocker from Phase 2. `git2`'s `vendored-openssl` builds its own OpenSSL on
Linux, so the desktop crate does **not** add to the `libssl` dependency in §6.

### 10.2 `cargo clippy --workspace --all-targets` passes

Exit 0, with 6 distinct warnings — all consequences of macOS-gated code being
compiled out, none a portability defect:

| Warning | Location |
| --- | --- |
| unneeded `return` statement | `crates/daemon/src/proc_info.rs:385` (the Linux stub) |
| unneeded `return` statement | `crates/daemon/tests/reconnect.rs:1435` |
| `write_to_master` is never used | `crates/daemon/src/pty.rs:1291` |
| `parse_announced_pid` is never used | `crates/daemon/src/pty.rs:1325` |
| `assert_dies_within` is never used | `crates/daemon/src/pty.rs:1354` |
| `parse_lsof_pids` is never used | `apps/desktop/src-tauri/src/commands/mobile/process.rs:169` |
| casting to the same type (`usize` → `usize`) | `crates/daemon/src/fd_transfer.rs:176` |
| casting to the same type (`u64` → `u64`) | `crates/visual-companion/src/discovery.rs:1524` |

`./kd test rust` runs clippy with `-D warnings`
(`tools/kd/src/runtime/rust-test.ts:20`), so a Linux CI lane would fail on these
until each is cfg-gated or fixed. That is Phase 1 backlog; nothing was fixed
here, because "make clippy quiet on Linux" is a change to macOS-shared code and
outside Phase 0's scope.

### 10.3 Bazel: Darwin-only, exactly as expected

Bazel itself is fine on linux-aarch64 — bazelisk fetched `9.0.1` from
`.bazelversion` and loaded and analyzed 149 packages / 1437 targets. The graph
is what stops:

```
$ bazel build //crates/daemon:kanna_daemon
ERROR: Target //crates/daemon:kanna_daemon is incompatible and cannot be built,
       but was explicitly requested.
Dependency chain:
    //crates/daemon:kanna_daemon
    @@rules_rust++crate+daemon_crates//:base64-0.22.1
    @@rules_rust++crate+daemon_crates__base64-0.22.1//:base64
      <-- target platform (@@platforms//host:host) didn't satisfy
          constraint @@platforms//:incompatible
```

Every `crate.from_cargo` in `MODULE.bazel` declares only
`aarch64-apple-darwin` / `x86_64-apple-darwin`, so `crate_universe` marks every
generated crate incompatible with a Linux host. Adding Linux triples is Phase 3
(release packaging) scope and was deliberately not attempted; `cargo` is
sufficient for Phase 0 and Phase 1.

## 11. Cost and capacity

| Measure | Value |
| --- | --- |
| `.build/` after the six sidecars | 4.9 GB |
| Disk after the sidecar builds | 19 GB used of 62 GB (40 GB free) |
| `pnpm install --frozen-lockfile` | 33.6 s |
| Cold daemon build (incl. Zig/Ghostty) | 180 s |

`tools/kd/src/runtime/rust-cache-policy.ts` disables `kache` on non-macOS, so
Linux builds get no shared Rust cache. That is tolerable at this size but is a
Phase 1 quality-of-life item, not a correctness one.

A second, larger cost: `libghostty-vt-sys/build.rs` clones
`github.com/jemdiggity/ghostty` into `OUT_DIR` whenever `GHOSTTY_SOURCE_DIR` is
unset, so a new build unit (a `cargo test` target after a `cargo build`, say)
re-fetches the whole repository — observed here as several concurrent
`git-remote-https` fetches during the test spike. Setting `GHOSTTY_SOURCE_DIR`
to one shared checkout is the obvious Phase 1 improvement for Linux
development.

The spec suggested 100–150 GB of disk; this VM has 64 GB. It was sufficient for
Phase 0 (peak 29 GB used of 62 GB after every spike, plus a ~2 GB Bazel cache). A full workspace build plus Bazel outputs
plus a GUI build will not fit; growing the qcow2 is an owner action.

## 12. E2E coverage note

Phase 0 adds no Linux CI and no Linux E2E lane, so the two repository changes in
§4 are covered only by unit tests (`cargo test -p kanna-runtime-defaults`,
`tools/kd/tests/setup.test.ts`) plus the manual `./kd setup --check` run in §4.
This section is the dated note the repository's E2E expectation asks for.

- **Why not testable yet:** there is no Linux runner in CI, and the desktop E2E
  harness is macOS/WKWebView-only (`tauri-plugin-webdriver`, debug builds).
- **What would make it testable:** a Linux runner (this VM, or native x86-64 CI)
  executing `cargo test` for the sidecar crates, which is enough for §4; the GUI
  lane needs the `tauri-driver` + `WebKitWebDriver` investigation the spec
  describes, and is Phase 2.
- **Narrower tests added meanwhile:** the cfg-gated triple assertion and the
  four `checkSetupPrerequisites` platform cases.

## 13. Reproducing

Guest scripts, kept under `~/kanna-phase0/` on the VM with full logs:
`provision-guest.sh`, `build-spike.sh`, `build-spike2.sh`, `build-spike3.sh`,
`build-spike4.sh`, `test-spike.sh`, `launcher-spike.sh`. The measurement probe used for
the identity and PTY spikes is a throwaway crate kept on the guest at
`~/kanna-probe` (deliberately outside the cargo workspace); the companion
document records the exact facility each measurement used, so Phase 1 does not
need its source.
