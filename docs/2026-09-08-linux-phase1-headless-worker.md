# Linux Phase 1: the headless worker

Date: 2026-09-08

Task: `6b4a48af` (plan-build-review dogfood). Reference:
[Linux desktop support](specs/linux-desktop-support.md), Phase 1
"Headless worker".

Predecessors:
[platform baseline and build evidence](2026-09-07-linux-phase0-platform-baseline.md)
and [identity, PTY, and launcher spikes](2026-09-07-linux-identity-pty-launcher-spike.md),
which measured the guest this phase implements against: Ubuntu 26.04.1,
kernel 7.0.0-31, aarch64, glibc 2.43, `yama.ptrace_scope=1`.

Phase 0 bounded the platform. This phase makes the daemon, the server, the CLI
and the sidecars **run** on it, under a launcher that can hold their trust
relationship, and proves the whole task lifecycle end to end on the VM.

## 1. Result

| Suite | Linux (VM) | macOS (Mac Studio) |
| --- | --- | --- |
| `cargo test -p kanna-daemon --no-fail-fast -- --test-threads=1` | **839 passed, 0 failed**, 4 ignored, across every target | **826 passed, 0 failed**, 4 ignored |
| `cargo clippy --workspace --all-targets -- -D warnings` (`--exclude kanna-desktop` on Linux) | exit 0 | exit 0 |
| `cargo test --workspace --exclude kanna-daemon --exclude kanna-desktop` | 2 174 passed, **4 failed** — all four the "no agent CLI installed" class, see §6 | all pass |
| `cargo test -p kanna-server` with any `claude`/`codex`/`opencode` executable on `PATH` | **1 352 passed, 0 failed** | — |
| `./kd test headless-worker` (the exit gate) | **16 passed** | 14 passed, 2 skipped (systemd-only) |
| `./kd test all` | — | **19 of 19 lanes green**; 3 212 Rust tests passed, 0 failed |

Phase 0's baseline was 651 passing / 113 failing daemon tests, 1 326/1 348
server tests, and a daemon that could not start at all.

The Linux numbers are from an idle VM (load < 1). The macOS numbers are from a
green `./kd test all`, but the Mac Studio was running many other Kanna tasks
throughout, at load averages of 38–63, and that is worth recording: two
*earlier* full runs each produced one failure in a different timing-sensitive
PTY fixture
(`recovery::tests::timed_out_worker_is_reaped_before_replacement_can_write`,
then `set_model_writes_a_control_line_to_stdin`). Both pass in isolation,
neither is in code this phase touched, neither reproduced twice, and in those
runs a target that normally takes 26 s took 89 s. These fixtures have
sub-second expectations, and a machine at load 60 is not a quiet one.

## 2. What Phase 0 measured, and what the implementation had to add

Phase 0's mapping table was accurate. Three things it could not have known came
out of writing the code, and each is a behaviour difference rather than a
spelling one.

### 2.1 A zombie keeps its identity on Linux and loses it on macOS

`proc_pidinfo(PROC_PIDTBSDINFO)` returns **0 bytes** for a zombie on macOS
(measured directly), so `process_info` there reports a dead-but-unreaped
process as gone. Linux keeps `/proc/<pid>` fully readable until the parent
reaps, so the same process still matches its recorded start-time identity.

Linux is the *safer* of the two: an unreaped zombie pins its pid, so a match
cannot be a recycled process. But it made `stop_verified`'s fault injection
unfalsifiable — the fixture kills the target to simulate pid recycling, and on
Linux killing does not release the pid. The injection now reaps on Linux, and
a new test pins the guarantee both halves depend on. Nothing about the
identity check itself was weakened.

### 2.2 Daemon handoff lost every session's descriptors

The most consequential find of the phase, and invisible to a spike that did not
run a handoff.

The old daemon writes its `HandoffReady` metadata line and then, on the same
stream, a one-byte message carrying the session descriptors as `SCM_RIGHTS`.
The new daemon read that line with a buffered reader. Measured, with the same
C program on both kernels:

| Sender writes | macOS `read(fd, buf, 8192)` | Linux `read(fd, buf, 8192)` |
| --- | --- | --- |
| a 24-byte line, then 1 byte + `SCM_RIGHTS` | returns **24** — stops at the ancillary boundary; the fds are still queued | returns **25** — glues the ancillary message's payload in and **discards its control data** |

So on Linux the following `recvmsg` found nothing and every handoff failed as
`EAGAIN` with all the descriptors already consumed. Both behaviours are legal;
only one is forgiving. The receiver now reads that frame a byte at a time,
which cannot cross the boundary, and says why.

### 2.3 `dash` does not run traps between builtins

Phase 0 noted that the guest's `/bin/sh` is `dash`. It also does not check
pending traps inside a loop of pure shell builtins:

| Blocker in a `trap 'exit 130' INT` script | SIGINT |
| --- | --- |
| `while :; do :; done` | **survives** — and spins at 100 % of a core |
| `while :; do sleep 0.2; done` | dies within one sleep |

The daemon's codex-interrupt fixture used the first shape *deliberately*,
because bash defers traps while an external foreground command runs. On Linux
that fixture ignored the interrupt, burned a core, and outlived the run —
which is what made the whole suite flaky by starving the VM. It now calls out
to `sleep`, which both shells interrupt promptly.

## 3. The identity backend

`crates/daemon/src/proc_info.rs` has a real Linux backend on procfs. Each
primitive Phase 0 flagged is implemented against its measured caveat and
documented where it lives:

- `process_info` parses `/proc/<pid>/stat`, splitting at the **last** `)`
  because `comm` may contain spaces and parentheses; `tty_nr == 0` maps to
  `NO_TTY`; `Z` is zombie and both `T` and `t` are stopped.
- `StartTime` is `(starttime_ticks, 0)` at 10 ms resolution. The module states
  that `(pid, start)` — never `StartTime` alone — is the identity, and why
  `pid_max = 4194304` makes that safe.
- `socket_peer_pid` uses `SO_PEERCRED`, frozen at `connect()` exactly like
  macOS's `LOCAL_PEERPID`, so the live rechecks stay mandatory.
- `slave_device_of_master` uses `TIOCGPTN` and fails safe on a device that does
  not fit 32 bits.
- `pipe_end_belongs_to` proves the weaker statement Linux can actually support:
  *some* descriptor in that process refers to this same pipe in the **opposite**
  direction. Both ends share one inode there, so no "far end" handle exists.
  The doc comment says so rather than implying the macOS claim.

Every lookup fails safe: an entry that is not this user's, or is unreadable or
vanished, reads as "unavailable", never as "alive". The same-user part is an
explicit check rather than a consequence of permissions — `/proc/<pid>/stat` is
world-readable and none of the fields read here are ptrace-restricted, so
another user's process would otherwise read as perfectly available and
`identity_alive` would answer "yes, that is alive" about a process this daemon
can neither signal nor inspect. A same-user zombie still keeps its identity,
which is what the teardown protocol depends on.

`process_executable_path` keeps byte-exact comparisons, with **no `(deleted)`
tolerance**. The consequence is written into `crates/daemon/SPEC.md` and the
worker's own docs: binaries are upgraded by replacing the file and restarting
the supervisor and server. The incumbent daemon never re-reads its own path, so
daemon replacement across an upgrade still works. Installed live-upgrade
handoff remains a Phase 3 test and is not claimed here.

**One fix unblocked 113 failing tests**, as Phase 0 predicted.

## 4. PTY, paths, and shell

- **`EIO` is a hangup.** A PTY master whose last slave closed reports EOF on
  macOS and `EIO` on Linux, so every normal session end was logged as an error.
  Both now reach one hangup path, behind a shared classifier with a portable
  `openpty` test. The same rule was needed in a server test helper, which was
  panicking on it.
- **`MSG_CMSG_CLOEXEC`** makes the kernel create received descriptors
  close-on-exec on Linux. `spawn_fd_boundary()` stays — macOS has no such flag
  and still needs the fence — and a test pins which platform gets which.
- **One path contract.** `app_support_dir_for_home` is
  `~/Library/Application Support` on macOS and the XDG data directory on Linux,
  resolved the way `dirs::data_dir()` does, which is how `kanna-server` reaches
  the same place. That closes the split brain Phase 0 found, where the daemon
  looked under `~/Library/…` while the server used `~/.local/share/…`. `kd`,
  the recovery sidecar and the kanna-mcp harness mirror the same rule.
- **Control sockets** move to `$XDG_RUNTIME_DIR` when the session manager
  provides one. Phase 0's reason stands: `fs.protected_regular` and
  `protected_fifos` do not cover socket paths, so a shared `/tmp` socket path is
  pre-creatable by any local user, while `/run/user/<uid>` is `0700`.
- **Shell policy.** macOS keeps `/bin/zsh` and its exact argv. Linux takes
  `$SHELL` when it is an absolute, executable `bash` or `zsh`, else
  `/bin/bash`, else `/bin/sh`. Phase 0's finding is the reason it is not simply
  "install zsh": a freshly installed zsh with no `~/.zshrc` runs
  `zsh-newuser-install`, an interactive wizard that the PTY bootstrap sees
  instead of its setup output. "Login" is spelled differently by these shells
  and it matters — `dash` rejects `--login` outright — so the argument vectors
  live beside the path. `rehash` became POSIX `hash -r`.

## 5. The launcher

`crates/kanna-worker` is the per-user supervisor Phase 0's launcher spike
pointed at (design 1 of its four). Phase 0 established that the alternative is
not merely discouraged: a daemon parented directly by `systemd --user` can
*never* capture a trust root, because the user manager holds capabilities and
is therefore non-dumpable.

It spawns the daemon and the server as its own direct children, waits for each
to publish real evidence of readiness, sends `adopt_desktop` on the
human-control socket, and issues `AuthorizeServer` — again on every new daemon
generation, because authorization is scoped to one.

Signals carry the desktop's semantics deliberately:

| Signal | Effect | Why |
| --- | --- | --- |
| `SIGHUP` (`systemctl --user reload`) | spawn a replacement daemon | live sessions hand off, exactly as when a newer app launches; the successor's parent is this still-live supervisor at the same path, so successor auth passes |
| `SIGTERM` | stop the server, leave the daemon and its sessions running | this is what closing the desktop app does; sessions outliving their operator's UI is the daemon's reason to exist |
| `kanna-worker stop-daemon` | stop the daemon and its sessions | the explicit teardown, and the only one |

The unit sets **`KillMode=process`** for the same reason: without it a unit
restart takes every agent session on the machine with it. It also sets an
explicit `PATH`, because a user unit inherits almost none and the toolchains
agent CLIs need come from interactive shell startup files that never run there.
Surviving logout needs `loginctl enable-linger`, which `install-unit` reports
rather than doing.

The worker takes an explicit `--db-path` (and honours `KANNA_DB_PATH`). Without
one it could only ever be a machine's single canonical instance — it opened
this developer's real Kanna database the first time the gate ran — and two
worktrees could not run side by side, which is what `kd` already gives the
desktop.

Three more things the launcher had to get right, each reproduced with real
binaries rather than reasoned about:

- **`stop-daemon` aims a signal, it does not trust a number.** It used to
  SIGTERM whatever pid its record named; a `/bin/sleep` whose pid was placed in
  an isolated record was duly killed, and the worker then reported "no daemon".
  A pid is not a process. The supervisor now records its start-time identity,
  its executable and the instance it supervises, and every one of those is
  re-checked against the live process before a signal is sent — the same
  `(pid, start)` identity the daemon uses everywhere else. Pids that are not
  addressable as one process (0, 1, anything that does not round-trip through
  `pid_t`) are refused outright, because `kill` reads them as a process
  *group*.
- **The generated unit carries the database it resolved.** `render` dropped
  `--db-path`, so an isolated worker installed as a unit came back up against
  the machine's canonical desktop database on its next boot — the one database
  an isolated instance must never touch. Whatever `install-unit` resolved
  (`--db-path`, else `KANNA_DB_PATH`, else the canonical path) is now in
  `ExecStart`, and the gate runs the generated command for real and asks the
  server which database it opened.
- **`server.toml` is private.** It carries `desktop_secret`, and it was being
  written with a plain `fs::write`: under the default 022 umask that is 0644,
  which made the 0600 on the identity file beside it pointless. It is now
  written 0600 *and re-secured on every start*, because `OpenOptions::mode`
  only applies to a file the call creates — a config an earlier version left
  world-readable would otherwise have stayed that way.

Verified on the VM: `/proc` shows both the daemon and the server as direct
children of the worker, the server answers `/v1/status`, and the identity file
beside the config is mode `0600`.

## 6. The exit gate

`tests/headless-worker` (`./kd test headless-worker`) drives a real
`kanna-worker`. It starts **nothing else** — proving the daemon and server come
up and get authorized is the point — and asserts durable rows, branches and
worktrees, never terminal output.

| Gate step | Assertion |
| --- | --- |
| launcher | the daemon and the server are direct children of the supervisor |
| create | a `pipeline_item` row at the first stage of a two-stage workflow |
| execute | `runtimeState` reaches a running value; the recorded worktree exists |
| durable input | a `task_input` row with the **full** 1 047-byte single-line message, its declared `operator` source and its stage; `deliveredInputCount` is 1; the agent received that line whole and submitted it exactly once |
| completion | a terminal `stage_run` carrying the summary, and a `run.finished` event |
| stage fork | stage becomes `review`; the branch is `task-<id>-2`, cut from the task's **committed tip**; its worktree exists; the run records `trigger = operator` |
| server restart | SIGKILL the server; the supervisor replaces it, the **same** daemon generation is still serving, and the live session still accepts input |
| daemon replacement | `SIGHUP`; a successor publishes, and the live session survives it — input after the handoff reaches the agent and is recorded |
| supervisor loss | the supervisor is SIGKILLed under a live session and another starts on the same instance: exactly one process listens, `/v1/status` answers, the replacement is still alive 30 s later, and `send-input` still lands |
| close | the task records `closed_at`, keeps its last stage, its worktrees are gone, and **every branch survives** |
| unit (Linux only) | the generated unit carries `KillMode=process`, `ExecReload`, and an explicit `PATH`; `install-unit` writes to the XDG user unit directory |

`tests/headless-worker/src/process.e2e.test.ts` covers four more things that
are only visible with real processes — which process got signalled, which
database got opened, what mode a file was left in:

| Regression | Assertion |
| --- | --- |
| `stop-daemon` aims a signal | a `/bin/sleep` a stale record merely *names* survives, and nothing is reported as asked to stop |
| `stop-daemon` still works | a real supervisor and its daemon are both gone afterwards |
| the generated unit | the `ExecStart` it prints is run for real, and the server it starts has the *selected* database open and no other, with the canonical path never created |
| `server.toml` | 0600 when created under a 022 umask, and re-secured when an earlier run left it 0644 |

### Losing the supervisor

The recovery case above is the one that had to be built twice. Reproduced on
the VM: a supervisor is SIGKILLed, its daemon and server survive reparented to
init, and the unit restarts the supervisor two seconds later. The replacement
spawned a server that died on `Address already in use` — but not before its
`human_control::serve()` had unlinked and rebound the human-control socket,
cutting the *surviving* server off from `adopt_desktop`. Readiness then read
the orphan's `/v1/status` and reported the dead child as serving, so the pid
authorized on the daemon held nothing and every task input was refused as
"system-input peer is not the pinned kanna-server process". Under
`Restart=on-failure` that repeats forever, spawning a daemon generation per
round.

The supervisor now asks before it spawns, the way the desktop's
`MobileServerManager::start` does: probe `/v1/status`, and if a server answers,
adopt it when it reports this worker's own `desktopId` or stop it when it does
not. Readiness for a server it *does* spawn is tied to that child — the child
exiting is a failure, and the answering process must be the one holding the
listening socket — and any failure after a spawn kills and reaps the child.
Both launchers now ask "who is listening" through one crate,
`crates/server-process`, rather than two copies that could disagree about who
owns a port.

Repeated by hand on the VM against the fix:

```text
== 1. first supervisor
supervisor=30193 daemon=30203 server=30216
== 2. kill -9 the supervisor
daemon alive: yes (ppid 1)
server alive: yes (ppid 1)
== 3. second supervisor, same data dir / db / ports
[worker] daemon generation 30331 is serving
[worker] adopted the kanna-server already serving on http://127.0.0.1:49320 (pid 30216)
== 4. state
listeners on 49320: 30216          # one, and it is the survivor
/v1/status: {"state":"running","desktopId":"worker-319a75e0...
daemon generations spawned: w1.log:1 w2.log:1
== 5. supervisor still alive after 30s
second supervisor 30321 still running
== 6. teardown
supervisor alive: no / daemon alive: no / listeners on 49320: ''
```

Two things the lane had to learn, both now documented in it:

1. It drops **every** inherited `KANNA_*` variable. A lane run from inside a
   Kanna task otherwise inherits that task's own completion context, and
   `stage-complete` addressed the session that was running it. (It was refused
   as stale. The daemon applies the same rule to every child it spawns, for
   exactly this reason.)
2. It waits for the agent's own readiness marker before speaking. A running
   *session* is not yet a running *agent*: the PTY starts with a login shell
   that runs repo setup and only then execs the provider, and input sent before
   that reaches the shell.

### Fixtures that leaked, and one that could not be interrupted

Phase 0 recorded that a `--no-fail-fast` daemon run wedged on three `sleep`
processes orphaned to init, and named "detached descendant teardown" as a
Phase 1 requirement. The identity backend is what lets the daemon's sweep find
them, but the harnesses never gave it the chance: they SIGKILL their daemon,
and a SIGKILLed daemon runs no teardown. On macOS the orphans idle; on Linux
several of them are shells looping as fast as they can, and two spinning
orphans on an 8-vCPU VM starve everything else until unrelated suites fail on
timeouts. Every daemon test harness now tears its sessions down through the
daemon's own `Kill` before killing it — guarded by the socket peer's pid, so a
*superseded* handle dropped while its successor holds the socket cannot
destroy the session under test. A full run now leaves nothing behind.

The codex-interrupt fixture was a second, subtler case, and its cause is a
platform contract rather than a leak. The daemon ignores SIGINT (with SIGHUP
and SIGQUIT) so that a Ctrl-C aimed at whoever launched it cannot take the
sessions down, and an **ignored** disposition survives `exec` into the child —
measured on the guest as `SigIgn: …7` on the agent process. POSIX then forbids
a shell from trapping a signal that was ignored when it started, so the
fixture's `trap 'exit 130' INT` in `/bin/sh` was silently a no-op and the fake
agent never responded to the interrupt. A real agent CLI is not a shell: it
calls `sigaction` itself, which overrides an inherited ignore. The fixture now
does the same, and so exercises the path a real provider actually takes.

### Test fixtures that encoded a macOS kernel constant

Several daemon fixtures asserted platform behaviour rather than product
behaviour, and Phase 0 predicted two of them. The rule applied throughout: a
test may not require a boundary the daemon does not control.

- `raw_input_at_the_incident_length_is_split_by_the_pty_queue` stays as the
  **macOS** incident fixture, because it asserts that the kernel split the
  write — Phase 0 measured the same 1 047-byte write arriving whole on Linux.
  It is gated with that reason, and no "Linux queue size" replaces it.
- The two logical-framing tests it exists for now **fragment the consumer**
  themselves, at a fixed 128-byte read, so the framing guarantee is asserted on
  both platforms instead of only where the kernel happens to split. One of them
  also stopped asserting that the Enter arrived as its own *read*, which the
  daemon cannot promise; it asserts the byte order, which it can.
- The flood/backpressure tests were silently void on Linux. AF_UNIX flow
  control is the **sender's** `SO_SNDBUF` there, not the receiver's clamp:
  measured, a writer into a socket clamped to `SO_RCVBUF` 4096 blocked after
  8 KiB on macOS and after **180 KiB** on Linux. A flood sized for macOS fit
  entirely inside kernel buffers, nothing stalled, and the tests passed while
  exercising none of the backpressure they exist for. Flood sizes now scale
  with the platform, and the Linux delivery ceiling is measured rather than
  scaled — see below.
- Cross-version handoff (`previous_daemon`) **skips on Linux with a stated
  reason**: the archived previous release predates Linux support and cannot
  start there, so there is no previous Linux daemon to hand off from. The skip
  notice says the invariants were not exercised, and the constant that controls
  it says to revisit at every tag bump.

### Sizing the Linux flood ceiling

Scaling each test's macOS ceiling by a constant was wrong, and one test failed
3 of 3 isolated runs on an idle VM because of it. A Linux flood is a *fixed*
512 KiB whatever the macOS base is, so the time to deliver one does not scale
with that base: a 1.5 s base became a 7.5 s ceiling, which is inside the
machine's own delivery time.

Measured with `measure_flood_delivery_with_and_without_a_stalled_observer`
(`#[ignore]`d, in `reconnect.rs`), on the idle VM, three runs of each
condition:

| run | no stalled observer | stalled observer attached |
| --- | --- | --- |
| 1 | 7 226 ms | 7 532 ms |
| 2 | 5 505 ms | 5 224 ms |
| 3 | 4 457 ms | 4 960 ms |

So 68–115 KiB/s — and **the stalled observer costs nothing**. The with/without
difference (−281 ms to +503 ms) is well inside the 2.8 s spread of the *same*
condition, so the healthy path is not being delayed and there is no daemon
regression here; the ceiling was simply below the machine's throughput. The
Linux floor is now 30 s, four times the slowest delivery observed. That
headroom is affordable because the regression these tests guard is
*unbounded*: the observer write had no timeout at all, so a saturated observer
froze PTY ingestion indefinitely. Any finite ceiling catches that; one below
the machine's own throughput catches nothing but the machine.

### The four remaining server failures, and the two Phase 0 left unclassified

All four are the **"no agent CLI installed on this machine"** class, not a
Linux portability defect. Two of them are the pair Phase 0 could not classify:

- `http_api::tests::actions::advance_stage_route_records_stage_run_for_spawned_next_task`
- `http_api::tests::revision_status::review_prompt_receives_the_implementer_result_while_prev_result_keeps_the_post_result`

plus `task_creator::tests::core::a_teardown_spawn_names_no_agent_cli_to_probe`
and
`task_creator::tests::core::prepare_task_prefers_explicit_then_repo_then_agent_definition_over_default_provider_setting`.

Reproduced on macOS first, as the plan required: they pass there because a real
`claude` is installed. Putting any executable named `claude`, `codex` and
`opencode` on the guest's `PATH` takes `kanna-server` from 1 348/4 to
**1 352 passed, 0 failed** — which is the whole of the difference.

That is a real hermeticity gap — these tests depend on the developer's machine
despite their fixture shipping fake providers, and one of them
(`advance_stage_route_…`) even overwrites the fixture's own
`workspace.path.prepend` — but it is a pre-existing, cross-platform test
problem rather than Phase 1 scope, so it is recorded here and left alone.

### Harnesses that mirrored a path

Moving the control sockets to `$XDG_RUNTIME_DIR` breaks any test that computes
that path itself, and three did: two `kanna-server` harnesses that `env_clear()`
the server they spawn (so it could not see the variable and looked in `/tmp`
while the fake daemon bound the real path), and one shared fixture that
hardcoded `/tmp`. In each case the server waited forever for a daemon
generation and never opened its listeners — a failure that reads as "the server
never became ready" and says nothing about why. All three now resolve the
directory the same way the product does, and say so.

## 7. Reproducing

On the Mac Studio, against the VM described in the Phase 0 baseline:

```
ssh kanna-linux-vm                     # 192.168.64.2, key auth from Phase 0
export GHOSTTY_SOURCE_DIR=$HOME/.cache/ghostty-src   # one shared checkout
export XDG_RUNTIME_DIR=/run/user/1000                # for systemctl --user over SSH
cd ~/kanna
cargo test -p kanna-daemon --no-fail-fast -- --test-threads=1
cargo clippy --workspace --all-targets --exclude kanna-desktop -- -D warnings
./kd test headless-worker
```

To re-derive the Linux flood ceiling rather than adjusting it by feel:

```
cargo test -p kanna-daemon --test reconnect -- --ignored --nocapture \
    measure_flood_delivery_with_and_without_a_stalled_observer
```

`GHOSTTY_SOURCE_DIR` matters: unset, `libghostty-vt-sys`'s build script clones
the whole Ghostty repository into every new `OUT_DIR`, which Phase 0 observed
as repeated concurrent fetches. One clone of the pinned commit at
`~/.cache/ghostty-src` removes it.

To run the worker by hand:

```
cargo build -p kanna-worker -p kanna-daemon -p kanna-server -p kanna-cli
.build/debug/kanna-worker run --data-dir /tmp/worker --db-path /tmp/worker.db \
  --lan-port 49120 --transfer-port 49130
.build/debug/kanna-worker print-unit          # the systemd --user unit
.build/debug/kanna-worker install-unit        # writes it, then tells you the next steps
```

## 8. E2E coverage

This phase's changes cross every boundary the repository's E2E expectation
names — server ↔ daemon ↔ PTY ↔ git ↔ service manager — and
`tests/headless-worker` is that coverage, running on both platforms. Unit tests
in the identity, PTY and path work are necessary but were never sufficient:
the handoff descriptor loss in §2.2 passes every unit test in the repository.

What the lane still does not cover, and why:

- **A unit restart under a live session.** The lane asserts the unit's
  `KillMode=process` and `ExecReload` contents rather than performing
  `systemctl --user restart` against an installed unit, because installing a
  user unit is a change to the machine running the tests. Verified by hand on
  the VM instead; the automated form belongs with Phase 3's installed-artifact
  lane.
- **Cross-version handoff on Linux**, until a Linux-capable release tag exists
  (§6).
- **Installed live upgrade**, which is Phase 3 and is deliberately not claimed
  by the strict `(deleted)` rule in §3.

## 9. Left for later

- The agent-CLI hermeticity gap in §6, which affects macOS equally.
- `SO_PEERPIDFD` / pidfds. Phase 0 measured them working and stronger than the
  macOS primitives; this phase mirrored the `(pid, start)` shape instead, which
  is adequate given `pid_max`. Adopting them means a kernel floor
  (`pidfd_send_signal` ≥ 5.1, `pidfd_open` ≥ 5.3, `SO_PEERPIDFD` ≥ 6.5) and is
  a decision, not a cleanup.
- The `rustls` move for `kanna-server`'s `tokio-tungstenite` and the default
  `reqwest` features in `kanna-cli`/`kanna-mcp`. Phase 1 kept `native-tls` and
  treats `libssl-dev` as a documented Linux build prerequisite, because
  changing it changes the macOS release relay socket's TLS stack and needs a
  Bazel crate repin.
- Linux CI. There is still no Rust CI job at all; `.github/workflows` holds only
  the schema Pages job.
- `process_inventory`'s `ps -o lstart=` identity could now come from
  `proc_info` instead.
