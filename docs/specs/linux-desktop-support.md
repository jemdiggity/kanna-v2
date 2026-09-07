# Linux desktop support: assessment and implementation reference

Date: 2026-09-07

Source task: `869376a8`

Status: researched recommendation; Linux execution has not yet been verified.

## Context and recommendation

Linux support is feasible, but it is a substantial platform port. Preserve
Kanna's distributed architecture and begin with a supported headless Linux
worker, then add the Tauri GUI on a narrowly defined Linux baseline.

The owner is setting up a Linux VM on the Mac Studio. A separate Linux machine
is not required to begin. The team intends to use the upcoming implementation
work to dogfood plan-build-review/dynamic workflows. This document is the
reference for those tasks, not an instruction to implement the entire port in
one task or a finalized specification of undecided platform policy.

The original assignment was discussion-only. This document records that
assessment following the owner's subsequent request to save and commit it.
No Linux implementation, Linux build, VM setup, or Linux test run was performed
in the assessment. Statements about current code describe the inspected
checkout; upstream availability was checked in September 2026. Implementation
tasks must recheck their actual base and supported dependency versions.

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

| Component | Assessment | Required work or validation |
| --- | --- | --- |
| Task/workflow model, SQLite, HTTP/KSP protocols | Works as-is at the core | Bundled SQLite, server-owned task lifecycle, durable inputs, and event feeds need no identified redesign. Exercise their real wiring on Linux. |
| Server startup and paths | Port work | Replace macOS application-support defaults consistently; define Linux data/config/runtime locations; remove hardcoded zsh assumptions; audit native TLS dependencies. |
| Loopback/LAN authorization | Works as-is conceptually | Preserve local credentials, Host checks, browser classification, and WebSocket authentication. Test actual WebKitGTK request behavior. |
| Basic PTY spawn/stream | Port work, largely reusable | Unix primitives carry over; validate controlling terminal, partial writes, EOF/EIO, resize, signals, descriptor inheritance, and cleanup. |
| Daemon identity and handoff | Substantial port work | Implement Linux process, socket-peer, terminal, and pipe ownership checks. Existing stubs cannot support safe startup. |
| Ghostty and terminal recovery | Port/build work | Build pinned native dependencies and recovery sidecar; validate snapshots, serialization, resource discovery, and transferred pipe ownership. |
| Vue stores/components/KeepAlive | Mostly reusable; GUI port work | Test activation/deactivation, terminal caches, hidden geometry, focus, and reconnect under WebKitGTK. |
| xterm and desktop integrations | Port work | WebGL/fallback rendering, fonts, IME, clipboard images, drag/drop, scrolling, scaling, shortcuts, and platform window behavior. |
| `kd` | Port work | Keep ports, tmux identity, and `.build/`; make setup, paths, launch plans, toolchain/release targets, and test launchers platform-aware. |
| Agent CLIs | Upstream Linux availability; Kanna integration unverified | Validate each provider's discovery, authentication, hooks/MCP, resume, terminal negotiation, and input behavior. |
| Mobile/discovery/relay | Mostly reusable; bootstrap work | Non-macOS Bonjour code already exists. Verify discovery, pairing, transfer, and cloud credentials without assuming a renderer. |
| Desktop E2E | Port work | Adapt the macOS-oriented harness to a Linux WebDriver backend and real Linux app launch. |
| Packaging, updates, service ownership | Platform contract needs design | Choose dependency boundary, installation layout, update owner, and lifetime semantics together. |

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
- Sidecar discovery must cover Linux installed and development layouts,
  including recovery, transfer, CLI/MCP, and bundled definitions.
- Server and desktop dependencies include `native-tls` consumers. Bundled
  SQLite and vendored libgit2/OpenSSL settings elsewhere do not prove the
  whole release is self-contained. Inspect the actual linked artifacts.

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

The entire `crates/daemon/tests/handoff.rs` suite and several process
adoption/cleanup tests are macOS-gated. Port their behavioral coverage, not
just compilation guards. Required Linux evidence includes forged identity/fd
rejection, detached descendant teardown, fd leak prevention, server restart,
authenticated daemon replacement, snapshot continuity, and real HTTP input
receipt plus durable ledger state. Existing shell/Perl fixtures and command
availability also need an explicit Linux test environment.

The [2026-09-06 PTY receipt note](../2026-09-06-logical-input-pty-receipt-e2e-note.md)
records both the incident and narrower test evidence. It also reports inherited
remote-E2E credential failures at that time. Reproduce the current baseline;
do not attribute every failure to Linux or treat that dated report as current
test status.

## Development on the Mac Studio

Use a full ARM64 Linux VM alongside macOS. The owner does not need to acquire
a Linux box. A VM provides a real Linux kernel for PTYs, `/proc`, credentials,
handoff, and service lifecycle testing, plus a desktop for WebKitGTK work.

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
measured implementation estimates. Re-estimate after the Linux build and
identity spikes; graphics and installed upgrades are major uncertainties.

| Phase | Deliverable and exit gate | Effort |
| --- | --- | --- |
| 0: Bound the platform | Confirm VM/distro/architecture and dependency policy; prove pinned sidecar builds; measure process identity and PTY behavior; decide launcher ownership. | S–M: 1–2 engineering weeks |
| 1: Headless worker | Daemon, server, CLI/MCP, definitions and recovery resources; Linux paths/shells; authenticated startup/handoff. Exercise create → execute → durable input → completion → stage fork → close, server restart, and daemon replacement. | L: 4–8 weeks |
| 2: GUI preview | Real Tauri app through `kd`, terminal matrix, Linux integrations/shortcuts, WebDriver lane, local credential tests, and paired mobile access. | L: 3–6 additional weeks |
| 3: Supported distribution | Clean-machine install without developer tools, signed update strategy, installed live-session upgrade tests, supported display/hardware matrix, release automation, support documentation. | M–L: 2–4 additional weeks |

The rounded planning envelope is approximately 10–20 engineering weeks for a
narrow supported GUI release; the individual ranges total 10–20 weeks. Multiple
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

1. Is the launch product a local headless worker, a full desktop replacement,
   or both in that order? Recommendation: both in that order.
2. Which distro/version, kernel baseline, CPU architectures, and display
   environments are supported? Start with one ARM64 VM baseline for local
   development; explicitly schedule x86-64 CI and release validation.
3. Does the vendoring rule permit declared OS/runtime libraries? Are agent
   CLIs and repository toolchains user-managed prerequisites?
4. Who owns launcher startup, daemon/server recovery, installation, and
   updates? Must sessions survive logout as well as app restart and upgrade?
5. Is local-only headless operation sufficient initially, or are paired mobile
   access and unattended cloud authentication release requirements?
6. Which real Linux users/hardware will supply graphics and desktop acceptance
   evidence beyond the Studio VM?

No answer to these questions should be inferred from the fact that Linux
support is planned. Resolve them in the owning implementation plans and record
the decisions alongside evidence.
