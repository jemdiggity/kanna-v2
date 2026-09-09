# Linux desktop support: assessment and implementation reference

Date: 2026-09-07

Source task: `869376a8`

Status: Phase 0 complete (2026-09-07, task `81ab28f1`). The ARM64 Linux VM
exists, all six pinned sidecars build and the daemon binary runs on it, and the
identity, PTY, and launcher spikes have been measured. Phases 1–3 remain
researched recommendation. Measured results now supersede the assumptions they
replace; see
[platform baseline](../2026-09-07-linux-phase0-platform-baseline.md) and
[identity/PTY/launcher spikes](../2026-09-07-linux-identity-pty-launcher-spike.md).

## Context and recommendation

Linux support is feasible, but it is a substantial platform port. Preserve
Kanna's distributed architecture and begin with a supported headless Linux
worker, then add the Tauri GUI on a narrowly defined Linux baseline.

The owner is setting up a Linux VM on the Mac Studio. A separate Linux machine
is not required to begin. The team intends to use the upcoming implementation
work to dogfood plan-build-review/dynamic workflows. This document is the
reference for those tasks, not an instruction to implement the entire port in
one task or a finalized specification of undecided platform policy.

The original assignment was discussion-only, and this document recorded that
assessment. Statements about current code describe the inspected checkout;
upstream availability was checked in September 2026. Implementation tasks must
recheck their actual base and supported dependency versions.

Phase 0 has since run. Where a claim below was an assumption and has since been
measured, this document says so inline and points at the dated evidence
document. Everything not marked as measured is still an assessment.

## System boundary

The path to preserve is:

1. Desktop, CLI, or MCP client requests a task through `kanna-server`.
2. The server owns SQLite, definitions, worktree creation, setup commands, and
   stage transitions, and asks the daemon to spawn an agent.
3. The daemon owns the PTY and authoritative Ghostty terminal state. A desktop
   terminal receives a snapshot and then live output; input travels back to
   the PTY through the existing authenticated paths.
4. Server-side daemon observation persists runtime/completion state and task
   events. Delivered logical input has a durable ledger independent of the
   terminal transcript.
5. Mobile consumes the same server over paired LAN access or the relay. Cloud
   authentication/bootstrap has additional renderer dependencies.

A Linux port must preserve these boundaries. It must not move orchestration
back into the GUI, replace durable events with terminal scraping, weaken
authorization, or replace daemon-owned terminal state with client replay.

Read [architecture](../dev/architecture.md), the
[server boundary](../kanna-server-boundary.md), and the
[daemon contract](../../crates/daemon/SPEC.md) before planning changes.

## Component feasibility

“Works as-is” means the core design appears reusable, not that a Linux binary
has passed tests. Effort is concentrated in platform integration and evidence.

Rows marked **[measured]** were checked on the Phase 0 VM; the rest are still
assessment.

| Component | Assessment | Required work or validation |
| --- | --- | --- |
| Task/workflow model, SQLite, HTTP/KSP protocols | Works as-is at the core | Bundled SQLite, server-owned task lifecycle, durable inputs, and event feeds need no identified redesign. Exercise their real wiring on Linux. |
| Server startup and paths | Port work **[measured: confirmed]** | The Linux daemon resolves its data dir to `~/Library/Application Support/Kanna/`, and `/bin/zsh` absence accounts for most of the 22 Linux server test failures. Replace macOS application-support defaults consistently; define Linux data/config/runtime locations; remove hardcoded zsh assumptions; audit native TLS dependencies. |
| Loopback/LAN authorization | Works as-is conceptually | Preserve local credentials, Host checks, browser classification, and WebSocket authentication. Test actual WebKitGTK request behavior. |
| Basic PTY spawn/stream | Port work, largely reusable **[measured]** | Resize, controlling terminal, and fd transfer verified working; `EIO`-not-EOF on hangup and the absent 1,022-byte split are the two concrete deltas. Unix primitives carry over; validate controlling terminal, partial writes, EOF/EIO, resize, signals, descriptor inheritance, and cleanup. |
| Daemon identity and handoff | Substantial port work **[measured: confirmed, and larger than "implement the stubs"]** | The Linux daemon aborts at `SuccessorAuthorizer::capture()` today. Every primitive has a Linux facility, but three carry different guarantees and the launcher shape is constrained (see the spike document). Existing stubs cannot support safe startup. |
| Ghostty and terminal recovery | Port/build work **[measured: builds]** | Pinned Zig 0.15.2 + Ghostty fork build natively; `kanna-terminal-recovery` builds and its tests pass. Still validate snapshots and transferred pipe ownership at runtime. Build pinned native dependencies and recovery sidecar; validate snapshots, serialization, resource discovery, and transferred pipe ownership. |
| Vue stores/components/KeepAlive | Mostly reusable; GUI port work | Test activation/deactivation, terminal caches, hidden geometry, focus, and reconnect under WebKitGTK. |
| xterm and desktop integrations | Port work | WebGL/fallback rendering, fonts, IME, clipboard images, drag/drop, scrolling, scaling, shortcuts, and platform window behavior. |
| `kd` | Port work **[measured: `kd setup --check` ported and passing on Linux]** | Keep ports, tmux identity, and `.build/`; make setup, paths, launch plans, toolchain/release targets, and test launchers platform-aware. |
| Agent CLIs | Upstream Linux availability; Kanna integration unverified | Validate each provider's discovery, authentication, hooks/MCP, resume, terminal negotiation, and input behavior. |
| Mobile/discovery/relay | Mostly reusable; bootstrap work | Non-macOS Bonjour code already exists. Verify discovery, pairing, transfer, and cloud credentials without assuming a renderer. |
| Desktop E2E | Port work | Adapt the macOS-oriented harness to a Linux WebDriver backend and real Linux app launch. |
| Packaging, updates, service ownership | Platform contract needs design **[measured: the dependency set is now known — `libc++1`, `libc++abi1`, `libssl3t64`, glibc ≥ 2.39]** | Choose dependency boundary, installation layout, update owner, and lifetime semantics together. |

## Daemon: the first substantial blocker

### What carries over

`crates/daemon/src/pty.rs` uses `openpty`, `fork`, `setsid`, `TIOCSCTTY`,
`dup2`, and terminal resize ioctls. Headless provider execution in `agent.rs`
uses `pre_exec`/`setsid`. These have Linux equivalents. Detaching the daemon
itself from the launching app's process group must also remain intact.

Unix-domain sockets and `SCM_RIGHTS` can preserve the existing transactional
handoff protocol. Keep the single-reader release barrier, registry sealing,
acknowledgment semantics, and fail-closed behavior on ambiguous handoff failure.
The process-wide spawn/fd boundary in `fd.rs` protects inheritable-descriptor
windows; preserve it while validating Linux ancillary-data and CLOEXEC behavior.

This is not an argument for replacing the daemon or terminal emulator. The
architecture is useful precisely because the Linux GUI can attach to the same
server/daemon contracts.

### What is missing

In `crates/daemon/src/proc_info.rs`, the non-macOS implementation supplies
Linux `/proc/{pid}/exe` lookup, but process information, process enumeration,
socket-peer identity, terminal ownership, and pipe ownership remain stubs
returning `None`, empty collections, or `false`.

`startup.rs` explicitly exits when it cannot capture the successor trust root
or operator trust root. The consequences extend beyond upgrades: normal
operator/server authorization, adopted-session liveness, signaling, and
descendant cleanup consume this information.

Implement a Linux backend for the existing boundary, including:

- Socket peer PID/credentials through `SO_PEERCRED`.
- Process start identity, parent, process group, state, and controlling-terminal
  information from `/proc`, with careful parsing and identity rechecks.
- Kernel-derived executable identity, including defined behavior when an
  executable is replaced or deleted during an update.
- Binding a transferred PTY master to its actual slave device and terminal
  members using Linux facilities rather than the macOS `TIOCPTYGNAME` path.
- Pipe type, access direction, and ownership proof using Linux descriptor
  information; sender-supplied PID metadata alone is not authority.

Linux socket credentials reflect connection establishment. They do not replace
the live peer/parent start-time and executable rechecks required before
ownership changes. Investigate pidfds for stronger signaling identity, but
decide their kernel baseline and semantics explicitly. `/proc` permissions,
namespaces, PID reuse, reparenting, and unavailable identity must fail safely.

Sources: [Linux Unix sockets](https://man7.org/linux/man-pages/man7/unix.7.html)
and [process stat fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

**Measured (2026-09-07).** Every primitive above has a working Linux facility,
and the running Linux `kanna-daemon` binary aborts exactly here — at
`SuccessorAuthorizer::capture()`, on its *own* pid, because `process_info`
returns `None`. Three of the seven differ in kind rather than spelling, and each
changes a guarantee: `starttime` has 10 ms resolution (macOS has microseconds),
both ends of a Linux pipe share one inode so "the peer holds the far end" is not
provable — only "someone holds this pipe in the opposite direction" — and
"no controlling terminal" is `tty_nr == 0`, not `NODEV`. `/proc/<pid>/exe` gains
a ` (deleted)` suffix after any in-place binary replacement, so a raw path
comparison fails across every upgrade. `SO_PEERPIDFD` and pidfds are available
and stronger than the macOS primitives. Yama `ptrace_scope` 1 *and* 2 leave all
the required `/proc` reads working. Full primitive-by-primitive table:
[identity/PTY/launcher spikes](../2026-09-07-linux-identity-pty-launcher-spike.md).

### Launcher and service lifecycle

The daemon captures its original launcher's kernel-derived executable while
that launcher is its live direct parent. A successor must be launched by the
trusted executable and pass the same checks before any handoff state changes.

A headless worker therefore needs an intentional replacement for the desktop's
launcher role. Starting daemon and server as unrelated systemd units is not,
by itself, an equivalent design. Prefer investigating a stable per-user
launcher/supervisor that owns startup and authorization while keeping the
server and daemon independent processes.

Specify survival across GUI close, supervisor restart, logout, and upgrade.
`setsid` alone does not establish service-manager/cgroup lifetime guarantees.
Test the chosen service configuration. Do not promise logout survival without
that decision and evidence.

Installation and update layout participate in this trust contract. AppImage
mount paths and executable replacement can change kernel-reported paths.
Stable paths help, but a real package-upgrade handoff test is required; do not
simply loosen path comparison to make upgrades pass.

**Measured (2026-09-07).** "Not, by itself, an equivalent design" turns out to
be too gentle: a daemon whose direct parent is `systemd --user` cannot capture a
launcher trust root *at all*. The user manager holds capabilities, so the kernel
marks it non-dumpable and `readlink("/proc/<pid>/exe")` returns `EACCES` to the
same uid. An ordinary user binary as parent (`gnome-shell`, `bash`) is readable.
The recommended shape — a Kanna-owned per-user supervisor started by a user unit
— is therefore the only one that satisfies both the trust root and
cgroup/linger lifetime. `enable-linger` was enabled on the VM and left enabled;
`KillUserProcesses` is `false` here only as a distro default. See the spike
document for the parent chains and the alternatives table.

## Server, clients, and dependencies

`kanna-server` already owns bundled `rusqlite`, task creation, terminal
observation, stage completion, and event feeds. This makes a useful headless
milestone possible without a frontend rewrite.

Identified platform assumptions include:

- `crates/runtime-defaults/src/lib.rs` constructs macOS application-support
  paths and returns `unknown-target` for non-macOS target triples.
- `tools/kd/src/context.ts` independently constructs macOS DB, daemon, and
  transfer paths. All consumers need one coherent Linux path contract.
- Server workspace execution and login-shell PATH discovery contain direct
  `/bin/zsh` invocations. Choose a supported shell policy rather than assuming
  zsh exists on a clean Linux machine.
  **Measured (2026-09-07):** absent `zsh` accounts for 15 of 22 `kanna-server`
  test failures on Linux. Installing it is *not* the fix: a freshly installed
  `zsh` with no `~/.zshrc` runs the interactive `zsh-newuser-install` wizard on
  every login shell, clears the screen and waits for a keypress, which Kanna's
  PTY bootstrap reads instead of its setup output. The policy must name a shell
  that is present and non-interactive out of the box, not relocate the
  hardcoded path.
- Sidecar discovery must cover Linux installed and development layouts,
  including recovery, transfer, CLI/MCP, and bundled definitions.
- Server and desktop dependencies include `native-tls` consumers. Bundled
  SQLite and vendored libgit2/OpenSSL settings elsewhere do not prove the
  whole release is self-contained. Inspect the actual linked artifacts.
  **Measured (2026-09-07):** confirmed, and it is a hard build failure, not a
  packaging nicety. `kanna-cli` and `kanna-mcp` reach `openssl-sys` through
  `reqwest`'s default features; `kanna-server` reaches it through
  `tokio-tungstenite`'s `native-tls` feature despite already using `rustls-tls`
  for `reqwest`. All three refused to build until `libssl-dev` was installed.
  The vendored `openssl-src` in `Cargo.lock` comes from the desktop crate's
  `git2 vendored-openssl` and does not cover them. Bundled SQLite is confirmed:
  no binary links `libsqlite3`.

Preserve `lan_trust`: a loopback address is not authorization for a browser.
Keep Host validation, Origin/Fetch Metadata classification, the local `0600`
credential, paired-device authorization, and first-frame KSP authentication.
Exercise actual packaged WebKitGTK origins and headers, including no-cors and
origin-less requests, against the real listener. A browser-engine change must
not silently invalidate assumptions about request classification.

Mobile should continue consuming the same server surface. The server already
has a non-macOS Bonjour implementation, but discovery and paired LAN behavior
need Linux validation. Account/relay bootstrap and token renewal require a
separate headless acceptance gate: existing flows can depend on credentials
minted by the signed-in renderer. A server registration command is not proof
that all unattended cloud flows work.

## Tauri, WebKitGTK, and terminal behavior

Linux Tauri uses WebKitGTK rather than macOS WKWebView. The Vue application is
largely reusable, but sharing the WebKit family does not prove identical
graphics, event, focus, or clipboard behavior.

Current relevant code:

- `TerminalTabs.vue` keeps warm terminal views through KeepAlive.
- `TerminalView.vue` resumes/refits/refocuses on activation and pauses on
  deactivation, with geometry observation and deferred focus handling.
- `terminalView.ts` attempts xterm WebGL rendering and disposes the addon on
  context loss, retaining a fallback renderer.
- Terminal input and app shortcuts explicitly handle Cmd/meta keys, while
  some lifecycle focus workarounds refer specifically to WKWebView.

Retain those lifecycle boundaries and validate warm/cold task switches, cache
eviction, hidden/zero-size terminals, sustained output, reattach snapshots,
resize, high DPI, font metrics, Unicode, IME, paste, selection, clipboard
images, file drops, and GPU context loss. Measure fallback rendering rather
than treating fallback availability as proof of acceptable performance.

Define Linux shortcuts without taking Ctrl+C away from the terminal. Test
window activation, dialogs, fullscreen, and focus transitions. Validate both
X11 and Wayland if both will be advertised as supported, including real
hardware feedback before broad graphics claims.

## Agent CLIs

Upstream documentation establishes Linux availability for all five registered
providers:

| Provider executable | Upstream reference |
| --- | --- |
| `claude` | [Claude setup](https://code.claude.com/docs/en/setup) |
| `codex` | [Codex CLI](https://developers.openai.com/codex/cli/) |
| `copilot` | [Copilot CLI installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| `opencode` | [OpenCode documentation](https://opencode.ai/docs/) |
| `agy` | [Antigravity CLI setup](https://antigravity.google/docs/cli/getting-started) |

Availability is not Kanna compatibility. Record tested versions and
architectures, then verify discovery from a GUI/service environment,
authentication, launch flags, hooks/MCP registration, terminal negotiation,
input framing, completion observation, and supported resume behavior.

A headless Kanna host can run interactive agents in daemon-owned PTYs. It does
not require provider SDK mode. The inspected registry marks only Claude,
Codex, and OpenCode as supporting headless provider execution; preserve each
provider's existing capabilities rather than assuming Linux makes them equal.

Decide whether agent CLIs and repository build tools remain user-managed
prerequisites. Kanna's own bundled runtime dependencies are a separate concern.

## `kd`, builds, and release packaging

Keep `kd` as the canonical development and release entry point. Worktree port
reservation, tmux server/session identity, and `.build/` remain valuable on
Linux. `runtime/sidecars.ts` already derives the Rust host triple and stages
all six sidecars with target suffixes.

Port setup's unconditional `xcode-select` check, platform paths, launch/test
plans, resource discovery, and release targets. The inspected Bazel graph is
oriented around Darwin triples, and release updater platform keys are
Darwin-only.

Ghostty's pinned Zig stack is a dependency even for headless operation. The
Zig 0.15.2 macOS SDK capability-probe patch is already scoped to ARM macOS.
Retain that scope and establish a native Linux toolchain; Linux should not
attempt to discover an Apple SDK. Validate pinned source/dependency fetching,
static linking where intended, and reproducible builds. Do not widen the port
into an unrelated Ghostty/Zig migration unless evidence requires it.

**Measured (2026-09-07).** Evidence does not require it. The pinned Zig 0.15.2
linux-aarch64 toolchain built the pinned Ghostty fork (`665a03f3`) natively for
all four `libghostty-vt-sys` consumers, with the macOS CLT patch never
consulted, and all six sidecars link. The one consequence to carry forward is
that Zig links LLVM's `libc++`/`libc++abi`, which a base Ubuntu image does not
have — a packaging dependency, not a build problem. `cargo` was used directly:
the Bazel graph is still Darwin-shaped (`supported_platform_triples`), which is
Phase 3 scope.

### Decide the Linux meaning of the vendoring rule

The current rule prohibits dependencies accidentally inherited from a build
machine and requires releases to run without developer tools. Linux needs an
explicit boundary for OS/runtime libraries. A conventional Tauri Linux package
is not a universally static executable.

| Format | Advantages | Kanna-specific costs |
| --- | --- | --- |
| deb | Narrow distro support, stable installed paths, package-manager integration | Conventional packages declare system runtime dependencies. Owner must accept that interpretation of vendoring or choose a different bundle strategy. |
| AppImage | Closer to a self-contained download | Host ABI baseline still matters; audit bundled libraries and daemon lifetime under mounted paths. Build on the oldest supported baseline. |
| Flatpak | Consistent distributed runtime | Host agent spawning, filesystem access, process inspection, and daemon lifetime conflict with default sandbox boundaries. A host service plus sandboxed UI adds another authenticated boundary. |

Prefer deb first if declared OS runtime libraries are acceptable, with
Kanna-owned dependencies, resources, and sidecars bundled. Otherwise investigate
AppImage before committing to the release plan. Defer Flatpak; broadly opening
its sandbox is not a substitute for an intentional architecture.

Linux removes Apple notarization, not the need for trusted updates. Decide
whether the package manager or Kanna owns updates, preserve signatures and
release-lineage policy, and exercise a real installed upgrade with live tasks.
Clean-machine validation must include TLS, fonts/resources, sidecars, and the
absence of build-machine paths or undeclared developer tools.

References: [Tauri Debian](https://v2.tauri.app/distribute/debian/),
[AppImage baseline requirements](https://v2.tauri.app/distribute/appimage/),
[Linux signing](https://v2.tauri.app/distribute/sign/linux/), and
[Flatpak sandbox boundaries](https://docs.flatpak.org/en/latest/sandbox-permissions.html).

## E2E and load-bearing macOS test assumptions

Kanna's current desktop E2E lane uses debug-only `tauri-plugin-webdriver` on
macOS WKWebView. Do not assume that dependency becomes Linux-ready merely
because current upstream Tauri documentation describes cross-platform testing.

First investigate adapting the existing W3C client to Linux `tauri-driver`
plus `WebKitWebDriver`, preserving task-specific ports and test isolation.
**Measured (2026-09-07):** `tauri-plugin-webdriver 0.2.1` itself compiles on
Linux as part of `cargo check -p kanna-desktop`. That removes one assumed
blocker; it says nothing about a real Linux app launch or a working
`WebKitWebDriver` session, which remain the actual work.
Current upstream also offers an embedded WDIO route; it is a different
integration from the current plugin, and adopting it should be a measured
choice rather than an automatic test-stack rewrite. Real GUI tests must run
the Tauri application, not only the browser mock frontend. A virtual display
can support unattended functional tests, with interactive VM/hardware testing
covering display and input behavior it does not represent.

References: [native Linux WebDriver setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/)
and [current Tauri WebDriver options](https://v2.tauri.app/develop/tests/webdriver/).

The recent PTY queue concern is concrete. In
`crates/daemon/tests/reconnect.rs`,
`raw_input_at_the_incident_length_is_split_by_the_pty_queue` requires a
1,047-byte write to split and asserts the exact 25-byte tail associated with
the observed macOS 1,022-byte boundary. Other receipt tests require splitting
at similar lengths or place Unicode across that boundary. Those are
macOS-specific premises, not portable kernel guarantees.

Keep the macOS incident fixture. Add portable receipt/framing tests using
controlled consumer fragmentation and Linux backpressure, asserting complete
ordered bytes and the submission contract without assuming a kernel read
size. Do not replace 1,022 with another magic “Linux queue size.” The daemon
does not control consumer read boundaries; bracketed-paste framing gives a
supporting consumer a logical boundary independent of those reads.

**Measured (2026-09-07).** The same 1,047-byte write into a pty master came back
from the slave as a *single* 1,047-byte read — in canonical and raw mode, framed
and unframed. There is no split to assert, so
`raw_input_at_the_incident_length_is_split_by_the_pty_queue` cannot pass on
Linux and must stay the macOS fixture. Two other PTY behaviours are concrete
code changes rather than open questions: the master read returns `EIO`, not 0,
once the last slave fd closes, so `output.rs`'s stream loop takes its error
branch — and logs `log::error!("PTY read error …")` — on every normal Linux
session end, and
`FD_CLOEXEC` does not travel across `SCM_RIGHTS` — confirmed — but
`fd_transfer.rs` already fences that window with `fd::spawn_fd_boundary()`
precisely because macOS lacks `MSG_CMSG_CLOEXEC`; Linux can additionally pass
the flag to close the window in the kernel, which is a deliberate improvement
rather than a fix. Resize, controlling-terminal acquisition, and fd transfer
otherwise carry over unchanged.

The entire `crates/daemon/tests/handoff.rs` suite and several process
adoption/cleanup tests are macOS-gated. Port their behavioral coverage, not
just compilation guards. Required Linux evidence includes forged identity/fd
rejection, detached descendant teardown, fd leak prevention, server restart,
authenticated daemon replacement, snapshot continuity, and real HTTP input
receipt plus durable ledger state. Existing shell/Perl fixtures and command
availability also need an explicit Linux test environment.

**Measured (2026-09-07).** The Linux `kanna-daemon` test picture is one blocker,
not a hundred: 651 tests pass and 113 fail, and every failure traces to the
`proc_info` stubs — 7 unit tests read them directly, and all 106 integration
failures across `agent_sessions`, `detection_rules`, `reconnect`,
`recovery_service`, and `worktree_isolation` are the harness failing to reach a
daemon that refused to start. Detached descendant teardown is already
demonstrably broken: the `--no-fail-fast` run left `sleep 300` escapees
reparented to init and holding the harness's stdout — one of them a deliberate
SIGTERM-ignoring fixture that needed `SIGKILL` — because the session sweep needs
`all_process_info()` (empty vec on Linux) and `slave_device_of_master()`
(`None`) to find processes that have left the process group. A Linux CI lane
will hang on that until the identity backend exists. Guest coreutils are the
Rust uutils build, which the shell/Perl fixtures should not assume away.

The [2026-09-06 PTY receipt note](../2026-09-06-logical-input-pty-receipt-e2e-note.md)
records both the incident and narrower test evidence. It also reports inherited
remote-E2E credential failures at that time. Reproduce the current baseline;
do not attribute every failure to Linux or treat that dated report as current
test status.

## Development on the Mac Studio

**Measured (2026-09-07).** The VM exists and is the Phase 0 evidence
environment. Full facts, toolchain versions, and a fresh-VM checklist are in the
[platform baseline](../2026-09-07-linux-phase0-platform-baseline.md); the
essentials:

| Fact | Value |
| --- | --- |
| Hypervisor | UTM (QEMU aarch64, Apple hypervisor), VM `Linux`, UUID `AFA4B3BF-1874-4CB2-AACD-82C47B8C2EC5` |
| Address | `192.168.64.2`, hypervisor shared/NAT network — invisible to LAN mDNS; lease in `/var/db/dhcpd_leases` |
| Access | `ssh kanna-linux-vm` (key `~/.ssh/kanna-linux-vm_ed25519`, user `jeremy`, password-free); `sudo` still prompts |
| Guest | Ubuntu 26.04.1 LTS aarch64, kernel 7.0.0-31, glibc 2.43, systemd 259, GNOME 50 / Wayland |
| Capacity | 8 vCPU, 15 GiB RAM, 64 GB disk (below the 100–150 GB suggested below) |
| Shell | `bash` login shell, `/bin/sh` is `dash`, **no `zsh`**; coreutils are the Rust uutils build |

Do not drive the guest through the UTM console window — it drops fast synthetic
keystrokes and captures Ctrl+Alt. Use SSH.

The original guidance below stands for anyone rebuilding this environment.

| Option | Role | Trade-off |
| --- | --- | --- |
| UTM | Free full Linux VM for development and GUI inspection | More manual setup; documented Linux OpenGL acceleration is experimental. |
| Parallels Desktop | Convenient full desktop VM with ready-made Linux options | Commercial option; still virtual graphics rather than a representative physical Linux GPU. |
| Multipass | Scriptable Ubuntu VM for headless worker development | Primarily suited to terminal-based work; less direct for interactive desktop verification. |
| Docker Desktop | Repeatable builds and isolated Linux tests | Supplementary tooling, not the acceptance environment for desktop/service lifecycle semantics. |

Start with Ubuntu ARM64 in UTM, or Parallels if the owner prefers its setup.
Suggested initial allocation, subject to Studio capacity: 8 vCPUs, 16 GB RAM,
and 100–150 GB disk. Keep the Linux checkout and `.build/` on the guest's Linux
filesystem to exercise Linux semantics and avoid shared-folder build overhead.
Use SSH from macOS for commands and the VM window for visual inspection.

This changes the original x86-64-first development suggestion: develop
natively on ARM64 locally and add native x86-64 Linux CI before claiming
x86-64 support. UTM can emulate x86-64, but it is a poor default for frequent
Rust builds. ARM64 VM success alone does not certify x86-64 packages.

VM graphics cover that virtual device only. Before broad desktop support,
recruit Linux beta testers for real GPU drivers, X11/Wayland, and desktop
environments. The owner need not own that hardware. The VM enables the port;
it does not remove the implementation blockers above.

References: [UTM](https://mac.getutm.app/),
[Parallels ARM Linux setup](https://kb.parallels.com/en/128445),
[Multipass](https://canonical.com/multipass), and
[Docker VM architecture](https://docs.docker.com/desktop/features/vmm/).

## Phasing, acceptance gates, and effort

These are rough engineering effort ranges for someone familiar with Kanna,
including meaningful verification. They are not calendar commitments or
measured implementation estimates. The spikes this section asked for have now
run; the table below is the re-estimate, and the paragraph after it says what
moved and why. Graphics and installed upgrades remain the major uncertainties —
Phase 0 touched neither.

| Phase | Deliverable and exit gate | Effort |
| --- | --- | --- |
| 0: Bound the platform | Confirm VM/distro/architecture and dependency policy; prove pinned sidecar builds; measure process identity and PTY behavior; decide launcher ownership. | **Done 2026-09-07**, inside one working session — well below the original S–M estimate, because the build spike came out clean |
| 1: Headless worker | Daemon, server, CLI/MCP, definitions and recovery resources; Linux paths/shells; authenticated startup/handoff. Exercise create → execute → durable input → completion → stage fork → close, server restart, and daemon replacement. **Now also: a Kanna-owned per-user supervisor/launcher binary and its user unit.** | **Done 2026-09-08** — the gate passes on the VM; see [the evidence](../2026-09-08-linux-phase1-headless-worker.md) |
| 2: GUI preview | Real Tauri app through `kd`, terminal matrix, Linux integrations/shortcuts, WebDriver lane, local credential tests, and paired mobile access. | L: 3–6 additional weeks (unchanged; the build-side risk is gone, the runtime risk is not) |
| 3: Supported distribution | Clean-machine install without developer tools, signed update strategy, installed live-session upgrade tests, supported display/hardware matrix, release automation, support documentation. **Now also: Linux triples in the `crate_universe` graph.** | M–L: 2–4 additional weeks (unchanged) |

What the evidence moved:

- **Down.** All six pinned sidecars build with unmodified crate sources; the
  pinned Zig 0.15.2 + Ghostty fork builds natively; `cargo clippy --workspace
  --all-targets` exits 0; `cargo check -p kanna-desktop` compiles against
  WebKitGTK 2.52 with a single dead-code warning, and even
  `tauri-plugin-webdriver` compiles. The test baseline is healthy: 313 of 314
  daemon lib tests and 1326 of 1348 server tests pass, and the failures
  concentrate into two causes (the identity stub, and `/bin/zsh`).
- **Up.** Launcher ownership is not a configuration choice: it needs a new
  Kanna-owned supervisor binary, which is a component with its own lifecycle,
  packaging, and upgrade-handoff story. The identity backend is not a
  transcription of the macOS one — three primitives carry different guarantees
  and the `/proc/<pid>/exe` ` (deleted)` behaviour needs a defined rule. The
  29 `handoff.rs` tests and 14 macOS-gated unit tests need behavioural Linux
  equivalents, and the macOS 1,022-byte receipt premise has to be replaced with
  portable tests rather than ported.
- **Unchanged and still unmeasured.** Graphics, fonts, IME, clipboard, GPU
  context loss, installed upgrades, x86-64, agent-CLI integration, and every
  mobile/cloud bootstrap question. Nothing in Phase 0 supports a claim about
  any of them.

The rounded planning envelope remains approximately 10–20 engineering weeks for
a narrow supported GUI release, now with the low end less likely. Multiple
distributions, Flatpak, and simultaneous architecture rollout increase scope.
Do not infer that multiple agents divide elapsed time linearly: identity,
launcher, package layout, and acceptance decisions have dependencies.

The headless milestone buys a useful Linux execution worker, Linux-native repo
testing, runtime CI, and proof that task orchestration survives without the
renderer. Local CLI/MCP control is the initial product. Paired LAN/mobile can
follow; unattended cloud sign-in/token renewal has its own gate. It does not
establish GUI quality or make macOS-specific repository setup commands portable.

For plan-build-review/dynamic workflow dogfooding, create bounded implementation
tasks around these gates. Each plan should name the system boundary, relevant
existing contract, exact acceptance evidence, and remaining decisions. Reviews
should assess that scoped plan plus durable delivered directives. This document
does not authorize unrelated refactors or replacement architectures. Update it
when a decision is made or a measured result replaces an assumption.

## Decisions before implementation commitments

Phase 0 was scoped to produce evidence for these, not to make them. None is the
build stage's to settle; each still needs the owner. What changed is that four
of the six now have measurements attached rather than assumptions.

Phase 1 was built under the recommended answers and did not settle any of
them. Where it committed code to one — the supervisor in question 4 — it says
so, and the commitment is reversible: `kanna-worker` is one crate that owns
startup and authorization only, and nothing else in the system knows it exists.

1. Is the launch product a local headless worker, a full desktop replacement,
   or both in that order? Recommendation: both in that order.
   **Still open — no new evidence; unchanged recommendation.**
2. Which distro/version, kernel baseline, CPU architectures, and display
   environments are supported? Start with one ARM64 VM baseline for local
   development; explicitly schedule x86-64 CI and release validation.
   **Evidence now in hand.** The development baseline is Ubuntu 26.04.1 aarch64,
   kernel 7.0.0-31, glibc 2.43. The *artifacts* built there need glibc ≥ 2.39
   (measured from their versioned symbols), so they would run on Ubuntu 24.04
   but not 22.04. Nothing about x86-64 was tested. The owner still chooses the
   supported floor and whether ARM64-only development is acceptable through
   Phase 1.
3. Does the vendoring rule permit declared OS/runtime libraries? Are agent
   CLIs and repository toolchains user-managed prerequisites?
   **Evidence now in hand.** The measured runtime dependency set is
   `libc++1` + `libc++abi1` (from the pinned Zig/Ghostty link, in four of six
   sidecars, and *not* present on a base Ubuntu image) and `libssl3t64` (from
   two crates still routing TLS through `native-tls`). Bundled SQLite is
   confirmed — no `libsqlite3` in any binary. The owner decides whether a deb
   declaring those is "vendored enough", or whether the `native-tls` consumers
   move to `rustls` first. Agent CLIs and repo toolchains remain unaddressed.
4. Who owns launcher startup, daemon/server recovery, installation, and
   updates? Must sessions survive logout as well as app restart and upgrade?
   **Answered in Phase 1 by building the recommendation:** `kanna-worker`, a
   Kanna-owned per-user supervisor under a `systemd --user` unit, is
   implemented and exercised. Installation and updates remain Phase 3, and the
   strict `(deleted)` rule means an installed *live* upgrade is explicitly not
   claimed. The evidence below is what the choice rested on.
   **Evidence in hand, and it eliminates one option outright.** A daemon
   launched directly by `systemd --user` can never capture a launcher trust
   root: the user manager holds capabilities, so it is non-dumpable and
   `/proc/<pid>/exe` is `EACCES` even to the same uid. The recommendation is a
   Kanna-owned per-user supervisor binary started by a user unit — an ordinary
   readable executable that owns startup and authorization while server and
   daemon stay independent processes. `enable-linger` is what buys
   logout survival; `KillUserProcesses=false` is only a distro default and must
   not be promised. Details and the alternatives table are in the
   [spike document](../2026-09-07-linux-identity-pty-launcher-spike.md).
5. Is local-only headless operation sufficient initially, or are paired mobile
   access and unattended cloud authentication release requirements?
   **Still open — no new evidence.**
6. Which real Linux users/hardware will supply graphics and desktop acceptance
   evidence beyond the Studio VM?
   **Still open — no new evidence.** The VM's GNOME/Wayland session is a real
   session but a virtual GPU; nothing here supports a graphics claim.

A seventh question surfaced during Phase 0 and belongs with these:

7. Should the daemon adopt pidfds (`pidfd_open`, `pidfd_send_signal`,
   `SO_PEERPIDFD`) on Linux rather than mirroring the macOS pid + start-time
   shape? They are available and measurably stronger, but they set a kernel
   floor (5.3 / 5.1 / 6.5), and Linux `starttime` has only 10 ms resolution
   against macOS's microseconds. Decide explicitly, with the floor written down.

No answer to these questions should be inferred from the fact that Linux
support is planned. Resolve them in the owning implementation plans and record
the decisions alongside evidence.
