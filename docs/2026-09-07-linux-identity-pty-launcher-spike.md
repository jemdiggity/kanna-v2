# Linux Phase 0: identity, PTY, and launcher spikes

Date: 2026-09-07

Task: `81ab28f1`. Reference:
[Linux desktop support](specs/linux-desktop-support.md) — "Daemon: the first
substantial blocker" and "Launcher and service lifecycle".

Companion: [platform baseline and build evidence](2026-09-07-linux-phase0-platform-baseline.md),
which describes the guest (Ubuntu 26.04.1, kernel 7.0.0-31, aarch64, glibc 2.43,
`yama.ptrace_scope=1`) all of these were measured on.

These are **measurements**, not a proposed implementation. `proc_info.rs`,
`pty.rs`, and `fd.rs` were not modified. Nothing here loosens an identity check,
and none of the PTY numbers below may be turned into a Linux constant in a test:
the daemon does not control consumer read boundaries, which is exactly the
lesson of the macOS 1,022-byte incident.

Measurements came from a throwaway probe crate kept on the guest at
`~/kanna-probe`, outside the cargo workspace. Each row below names the facility
it used, so the mechanism is reproducible without that source.

## 1. `proc_info` primitive mapping

The macOS backend gets everything from `proc_pidinfo(PROC_PIDTBSDINFO)`,
`proc_pidfdinfo`, `LOCAL_PEERPID`, and `TIOCPTYGNAME`. Linux has an equivalent
for every primitive, but three of them differ in kind, not just in spelling.

| macOS primitive (`crates/daemon/src/proc_info.rs`) | Linux facility | Measured | Caveat that changes the design |
| --- | --- | --- | --- |
| `process_info` → `ProcessInfo{ppid,pgid,tdev,is_zombie,is_stopped,start}` | `/proc/<pid>/stat` fields 4 `ppid`, 5 `pgrp`, 7 `tty_nr`, 3 `state`, 22 `starttime` | ✅ all fields present | `comm` (field 2) is unquoted and may contain spaces **and** parentheses — split at the **last** `)`, never by whitespace. |
| `StartTime = (start_tvsec, start_tvusec)` | `starttime` in clock ticks since boot | ✅ stable across reads | **Resolution is 10 ms** (`_SC_CLK_TCK=100`), against microseconds on macOS. 152 of 265 live processes shared a tick with another; two children spawned back to back got the *same* `starttime`. The `(pid, starttime)` pair is still unique — pids differ — but `StartTime` alone distinguishes far less than it does on macOS. `pid_max` is 4194304, so reuse inside one tick is not a practical risk; say so explicitly rather than assuming macOS-grade resolution. |
| `is_zombie` / `is_stopped` (`SZOMB`/`SSTOP`) | `state` field: `Z` / `T` or `t` | ✅ unreaped child reads `Z`; `SIGSTOP`ped child reads `T` | `t` (tracing stop) must count as stopped too. |
| `all_process_info` (`proc_listpids`) | `readdir("/proc")`, numeric entries | ✅ 265 pids, all readable, **2.3 ms** | Entries race with exit; treat a missing `stat` as "gone", not an error. |
| `process_executable_path` (`proc_pidpath`) | `readlink("/proc/<pid>/exe")` | ✅ | See §3 — the value **changes** when the binary is replaced or deleted. |
| `socket_peer_pid` (`LOCAL_PEERPID`) | `getsockopt(SOL_SOCKET, SO_PEERCRED)` → `struct ucred{pid,uid,gid}` | ✅ pid/uid/gid correct | Frozen at `connect()`, same as macOS: after the peer exited, `SO_PEERCRED` still returned its pid while `/proc/<pid>` was gone. The live peer/parent start-time and exe rechecks stay mandatory. **Linux additionally offers `SO_PEERPIDFD`** (option 77, kernel ≥ 6.5), which returned a working pidfd here — a strictly stronger identity than macOS's bare pid. |
| `slave_device_of_master` (`TIOCPTYGNAME` + `stat`) | `TIOCGPTN` (or `ptsname_r`) → `/dev/pts/N` → `stat().st_rdev` | ✅ | Measured against a member process's `tty_nr` at pts numbers 1 **and 400**: the kernel's `new_encode_dev()` in `/proc` and glibc's `st_rdev` agree bit for bit in the 32-bit range, so a raw comparison is sound for pts devices. Two things still differ from macOS: `ProcessInfo.tdev` is `u32` while Linux `st_rdev` is 64-bit (truncation is only reachable for `major > 0xfff`), and **"no controlling terminal" is `tty_nr == 0` on Linux, not `NODEV`/`u32::MAX`** — a Linux backend must map 0 to `NO_TTY` or every detached process will look like it owns tty device 0. |
| `pipe_peer_handle` + `pid_holds_pipe_end` (`PROC_PIDFDPIPEINFO` peer handle) | `readlink("/proc/<pid>/fd/N")` → `pipe:[<inode>]`, matched against `fstat().st_ino`; direction from `/proc/<pid>/fdinfo/N` `flags:` (octal) | ✅ peer located and its direction proven | **This is the one real semantic loss.** On Linux both ends of a pipe share one inode, so there is no distinct "far end" handle. The strongest provable statement is "some process holds *this same pipe* open in the *opposite* direction", not "that pid holds the far end". `pipe_end_belongs_to` must therefore keep its own `S_IFIFO` + `F_GETFL` direction checks on the received fd **and** check the peer's `fdinfo` direction, and its doc comment must state the weaker guarantee honestly. |

### Yama and `/proc` readability

`kernel.yama.ptrace_scope` restricts `PTRACE_MODE_ATTACH`, not
`PTRACE_MODE_READ`. Measured against a same-uid, **non-descendant** process at
scope 1 and at scope 2 (temporarily set, then restored to 1):

| `/proc/<pid>/…` | scope 1 | scope 2 |
| --- | --- | --- |
| `exe` | readable | readable |
| `fd/` | readable | readable |
| `stat` | readable | readable |
| `maps`, `environ` | readable | readable |

So a hardened `ptrace_scope` does **not** break the daemon's identity reads.
Two other things do, and they are what to fail safely on: a different uid
(`/proc/1/exe` → `EACCES` here), and a non-dumpable process (§4).

### pidfd

`pidfd_open(pid, 0)` succeeded; `pidfd_send_signal(fd, 0, …)` returned 0 while
the target lived and `ESRCH` after it was reaped — i.e. the fd refuses to
signal a recycled pid, which is the property `identity_matches` currently
buys with a start-time compare. Kernel baseline if adopted:
`pidfd_send_signal` ≥ 5.1, `pidfd_open` ≥ 5.3, `SO_PEERPIDFD` ≥ 6.5. Given the
10 ms `starttime` resolution above, pidfds are worth a Phase 1 decision rather
than a reflex "port the macOS shape"; they must be decided explicitly, with the
kernel floor written down.

## 2. Runtime directory and `/tmp`

`kanna_runtime_defaults::socket_path` puts the daemon control socket at
`/tmp/kanna-<hash>.sock`.

| Fact | Value |
| --- | --- |
| `/tmp` | mode `01777`, sticky, owned by root — shared between users |
| `fs.protected_regular` | `2` |
| `fs.protected_fifos` | `1` |
| Same-uid `O_CREAT` reopen of own `/tmp` regular file | allowed |
| `bind()` on a fresh `/tmp` socket path | succeeds, mode `0775`, `S_IFSOCK` |
| Second `bind()` on the same path | `AddrInUse` |
| `XDG_RUNTIME_DIR` | `/run/user/1000` (mode `0700`, per-user) |

`protected_regular`/`protected_fifos` cover regular files and FIFOs; they do
**not** cover socket paths. A hostile local user can pre-create the daemon's
`/tmp` socket path. That is not new on Linux — macOS has the same shape — but
Linux hands us a per-user `0700` runtime directory that removes the problem
outright. Phase 1's Linux path contract should use `XDG_RUNTIME_DIR`, and this
is the reason.

## 3. `/proc/<pid>/exe` across an upgrade

The launcher trust root is a kernel-derived executable path, so what that path
does during a package upgrade is a contract question, not a detail.

| Event | `readlink("/proc/<pid>/exe")` |
| --- | --- |
| baseline | `/tmp/…/live-binary` |
| after `rename()` of a new file over the running one | `/tmp/…/live-binary (deleted)` |
| after `unlink()` of the path | `/tmp/…/live-binary (deleted)` |

After the rename the path still exists on disk, holding a *different* inode,
while the running process's link carries the ` (deleted)` suffix. So a raw
string comparison of a captured launcher path against a re-read one **fails
across any in-place upgrade**, and an AppImage remount or a deb replacing a
binary both produce this.

The spec's rule stands: do not loosen the comparison to make upgrades pass.
Phase 1 needs a defined identity rule — strip a documented ` (deleted)` suffix
*and* pin the process identity that produced it, or capture something stronger
than a path — decided deliberately and covered by a real installed-upgrade
handoff test.

## 4. Launcher ownership — the decisive measurement

The daemon captures its launcher's kernel-derived executable **while that
launcher is its live direct parent**. Parent chains, with kernel-derived exe
paths, for the three plausible Linux launch shapes:

**(a) `systemd --user` transient unit** (`systemd-run --user --unit=… sleep`):

```
pid=15651 comm=sleep    pgrp=15651 session=15651 exe=/usr/lib/cargo/bin/coreutils/sleep
pid=3064  comm=systemd  pgrp=3064  session=3064  exe=<EACCES>
pid=1     comm=systemd  pgrp=1     session=1     exe=<EACCES>
ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/kanna-probe-daemon.service
Slice=app.slice  KillMode=control-group
```

**(b) plain SSH login shell, `setsid nohup`:**

```
pid=15709 comm=sleep         exe=/usr/lib/cargo/bin/coreutils/sleep
pid=15643 comm=bash          exe=/usr/bin/bash
pid=15642 comm=sshd-session  exe=<EACCES>   (root)
…
pid=1     comm=systemd       exe=<EACCES>   (root)
```

**(c) a real GNOME-session GUI app** (`ptyxis`, the desktop's terminal):

```
pid=6075 comm=ptyxis       pgrp=3612 session=3612 exe=/usr/bin/ptyxis
pid=3612 comm=gnome-shell  pgrp=3612 session=3612 exe=/usr/bin/gnome-shell
pid=3064 comm=systemd      pgrp=3064 session=3064 exe=<EACCES>
```

### The finding

**A daemon launched directly by `systemd --user` cannot capture a launcher
trust root at all**, even with a complete Linux `proc_info` backend:

```
$ ls -ld /proc/3064            drwxr-xr-x jeremy jeremy      # same uid
$ grep CapEff /proc/3064/status  CapEff: 0000000800000000     # holds capabilities
$ readlink /proc/3064/exe        EACCES (errno 13)
$ tr '\0' ' ' < /proc/3064/cmdline
  /usr/lib/systemd/systemd --user
```

The user manager is the same uid as the daemon would be, but it holds
capabilities, so the kernel marks it non-dumpable and `/proc/<pid>/exe` is
`EACCES` for an ordinary same-uid reader. `SuccessorAuthorizer::capture()`
requires `process_executable_path(launcher_pid)`; under (a) that is
unconditionally `None` and startup aborts by design. By contrast, an ordinary
user binary as parent — `gnome-shell` in (c), `bash` in (b) — is readable.

This is the spec's warning made concrete: "starting daemon and server as
unrelated systemd units is not, by itself, an equivalent design." It is not a
matter of preference. It does not work.

### Lifecycle

| Fact | Value |
| --- | --- |
| `logind` `KillUserProcesses` | `false` (distro default; `#KillUserProcesses=no` commented in `logind.conf`) |
| `Linger` for `jeremy` | was `no`; enabled during the spike and **left enabled** — see below |
| `user@1000.service` | active; `app.slice` transient units live in its cgroup with `KillMode=control-group` |
| Sessions | 4 (`tty2` seat0 GUI, one manager, two SSH) |

With `KillUserProcesses=false`, processes already survive logout on this image
— but that is a distro default a user or admin can flip, not a guarantee Kanna
may promise. `enable-linger` is what keeps `user@1000.service` (and therefore
any user unit under it) running with no session at all; it was enabled to
measure that and, unlike the `ptrace_scope` change, **was left enabled**,
because Phase 1's headless worker needs it and turning it back off would only
have to be undone. It is reverted with
`sudo loginctl disable-linger jeremy`.

`setsid` alone (shape (b)) gives no cgroup or service-manager lifetime
guarantee at all; it survives here only because of the `KillUserProcesses`
default.

### Candidate designs

| Design | Trust root | Verdict from the evidence |
| --- | --- | --- |
| 1. A Kanna-owned per-user supervisor binary, started by a `systemd --user` unit, which itself launches (and relaunches) the daemon | the supervisor's own exe — an ordinary user binary, readable like `gnome-shell` | **Recommended.** It is the only shape that satisfies `SuccessorAuthorizer` *and* gets cgroup/linger lifetime. Server and daemon stay independent processes; the supervisor owns startup and authorization only. |
| 2. `kanna-server` as the launcher | the server's exe | Works mechanically, but couples daemon lifetime and trust to the server's own restarts — the thing the current architecture deliberately separates. |
| 3. Desktop app as launcher on Linux too | the app's exe | Matches macOS and works, but there is then no headless story, which is the point of the Phase 1 milestone. |
| 4. Daemon and server as two unrelated `systemd --user` units | none — `EACCES` | **Does not work.** Measured above. |

The choice is the owner's; the evidence points at (1).

## 5. PTY behaviour

| Behaviour | macOS today | Linux measured | Consequence |
| --- | --- | --- | --- |
| Resize | `TIOCSWINSZ` → `SIGWINCH` | ✅ `TIOCSWINSZ(42×137)` delivered `SIGWINCH`; the child's `TIOCGWINSZ` read back `42x137`; master `TIOCGWINSZ` agreed | Carries over unchanged. |
| Controlling terminal | `setsid` + `TIOCSCTTY` + `dup2` | ✅ child's `/proc/<pid>/stat` shows its own `session` and the correct `tty_nr` | Carries over unchanged. |
| Last slave fd closes | master `read()` returns **0 (EOF)** | master `read()` returns **-1 / `EIO`** | **Behaviour change.** The PTY stream loop in `crates/daemon/src/output.rs` has an `Ok(0)` arm that logs `[stream] eof` and a catch-all error arm that logs `log::error!("PTY read error …")`. Both `break`, so the stream still terminates — but on Linux *every normal session end* takes the error branch and emits an error-level log. Map `EIO` on a PTY master to the hangup path before anything starts keying off that distinction. |
| Master write with a non-reading slave | — | first `write()` short at offset 8192; total accepted 11776 bytes; then `EAGAIN`. Identical in canonical and raw modes | A measurement of this kernel and line discipline. Do not encode it. |
| The 2026-09-06 incident shape: one 1047-byte write | slave's first read returned **1022**, tail 25 | slave's first read returned **1047** — the whole write, in canonical and raw mode, framed and unframed | **The macOS split does not occur here.** `raw_input_at_the_incident_length_is_split_by_the_pty_queue` in `crates/daemon/tests/reconnect.rs` *requires* a split and asserts the 25-byte tail; it cannot pass on Linux. Keep it as the macOS incident fixture, and add portable receipt tests that fragment the consumer deliberately and assert complete ordered bytes plus the submission contract — never a "Linux queue size". |
| `SCM_RIGHTS` fd transfer | used by handoff | ✅ received fd refers to the same pipe inode as the sender's | Carries over. |
| `FD_CLOEXEC` across `SCM_RIGHTS` | receiver gets inheritable fds; `fd_transfer.rs` wraps receive-and-mark in `fd::spawn_fd_boundary()` because "macOS has no `MSG_CMSG_CLOEXEC`" | sender's `FD_CLOEXEC` does **not** travel — confirmed: `recvmsg(flags=0)` yields a non-cloexec fd, `MSG_CMSG_CLOEXEC` yields a cloexec one | The existing design is already correct and must be kept; Linux merely offers a stronger primitive. Passing `MSG_CMSG_CLOEXEC` on Linux closes the inheritable window in the kernel instead of only fencing it. That is an improvement to make deliberately, not a bug to fix — the `spawn_fd_boundary` still has to exist for macOS. |

### Test-environment note

The guest's coreutils are the Rust uutils build: `/bin/sleep` resolves to
`/usr/lib/cargo/bin/coreutils/sleep`. Existing shell and Perl fixtures should
not assume GNU coreutils flag behaviour on a modern Ubuntu.

## 6. What Phase 1 now knows that it did not

1. The identity backend is the first blocker and it is **not** a mechanical
   port: `starttime` resolution, the shared pipe inode, `tty_nr == 0`, and the
   ` (deleted)` exe suffix each change a guarantee, not just a call.
2. `SO_PEERPIDFD` and pidfds are available and stronger than the macOS
   primitives; adopting them is a decision with a kernel floor attached.
3. Launcher ownership is settled by measurement, not taste: option 4 is
   impossible, option 1 is the only shape that keeps both the trust root and
   the service lifetime.
4. `EIO`-as-hangup and `MSG_CMSG_CLOEXEC` are two concrete code changes with no
   design ambiguity.
5. The 1,022-byte premise is macOS-only, confirmed by measurement rather than
   inference.
