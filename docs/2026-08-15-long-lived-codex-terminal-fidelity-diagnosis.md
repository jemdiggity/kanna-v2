# Long-lived Codex terminal fidelity diagnosis (2026-08-15)

## Scope and result

This was a read-only investigation of staging task `aed228ac`. The fixture was
not sent input, resized, reset, cleared, detached, restarted, killed, or moved
between stages. Read-only daemon `Snapshot` requests and KSP attachments were
used; they do not alter the task PTY or terminal dimensions. No implementation
from `cf1b5371` was resumed or copied.

The first demonstrated divergence is in the desktop replay boundary, not in
the captured raw-to-daemon-to-server path. KSP delivers a full authoritative
VT snapshot, but the desktop deliberately does not reset a retained xterm for
Codex. Replaying the same snapshot twice therefore appends the serialized
normal-buffer history a second time. With the shipped xterm build, the fixture
grew from 2,362 to 4,721 buffer rows after one duplicate replay; resetting and
replaying once returned exactly to the one-shot grid and hash.

This is a proven accumulation defect and a credible mechanism for the reported
long-session degradation. It is not, by itself, proof that it produced every
pixel in the earlier stale/truncated screenshot: the live fixture was quiet,
the captured snapshot was on the normal screen, and the live WebView xterm is
not introspectable in this staging build. Handoff is not the first observed
corrupting boundary. It preserved byte counts at both transfers, but it and
later desktop reconnects cause more full-snapshot replays into the retained
xterm.

## Authoritative runtime and controls

`kanna_info` reported the required staging instance:

| Property | Observed value |
|---|---|
| API | `http://127.0.0.1:48121` |
| environment/version | `staging`, `0.2.0-staging.1` |
| desktop id | `desktop-21b320e8-a5ad-4fae-9d87-1db14090f0a9` |
| daemon socket | `/tmp/kanna-2d7beacd.sock` |
| app support | `/Users/jeremyhale/Library/Application Support/build.kanna.staging/Kanna` |
| current desktop/daemon/server start | 2026-08-13 13:03 JST |

Process ancestry and task detail identified these Codex PTY sessions:

| Task | Role | Provider process start | Snapshot at comparison |
|---|---|---:|---:|
| `aed228ac` | primary fixture | 2026-08-12 05:54 JST | 120x42, 225,025 bytes, 2,362 xterm rows |
| `a75212da` | newer control | 2026-08-15 19:08 JST | 80x24, 361,001 bytes, 2,853 xterm rows |
| `42ab0ffe` | newer control | 2026-08-15 19:20 JST | 80x24, 67,047 bytes, 586 xterm rows |

The current staging desktop, daemon, and server were PIDs 59367, 59649, and
59671. The fixture's Codex wrapper/native processes were PIDs 52185/58867;
PID 52185 had PPID 1, consistent with survival across the daemon generation.
The controls were newer children of the current daemon. Task `14282f67` was
inspected but rejected as a control because it used Claude rather than Codex.
Task `42ab0ffe` naturally transitioned after its snapshot was captured; this
investigation did not cause that transition.

## Boundary trace

1. The daemon feeds PTY bytes into a Ghostty headless terminal and serializes
   it with `ghostty_xterm_compat_serialize` (`headless_terminal.rs`). Snapshot
   and attach-snapshot both take that live state under the session/fanout lock
   (`session.rs`, `connection.rs`). The serializer has a 10,000-byte scrollback
   budget and emits VT, not a structured primary/alternate-screen object.
2. `kanna-server` requests `AttachSnapshot` and base64-wraps the returned VT in
   `TermSnapshot`; it does not reinterpret those bytes (`ksp.rs`). Snapshot and
   subsequent output registration are atomic at the daemon fanout boundary.
3. The stream client forwards `term_snapshot` to the terminal lifecycle.
4. `TerminalTabs.vue` retains terminal components under `KeepAlive` (maximum
   10). Deactivation detaches KSP but preserves the xterm. Reactivation attaches
   again and obtains another full authoritative snapshot.
5. `terminalSessionLifecycle.ts` calls `reset()` before replay for other
   providers, but `shouldResetTerminalOnReconnect()` returns false for Codex.
   It writes the full snapshot into the already populated xterm. The original
   Codex exception came from commit `7c9dda70ab` (cached-xterm reconnect), while
   the current transport now supplies a full authoritative KSP snapshot. Its
   unit test asserts only that reset is avoided, not that replay is replacement
   or idempotent.

This makes the desktop the first boundary whose current contract disagrees
with its input: the producer supplies replacement state, while the Codex
consumer treats it as appendable output.

## Runtime evidence

### Daemon handoff and recovery

The fixture was spawned by daemon 57317. It crossed two daemon replacements:

| Transfer | Protocol adopted | Sender snapshot | Receiver adoption |
|---|---|---:|---:|
| 57317 -> 55214, Aug 12 22:17 | legacy-v2 | 977,682 bytes, 120x42 | 977,682 bytes |
| 55214 -> 59649, Aug 13 13:03 | legacy-v2 | 258,304 bytes, 120x42 | 258,304 bytes |

The second requester attempted transactional-v3, but the older sender completed
legacy-v2. Both transfers preserved the sender's exact serialized length and
then resumed output. No targeted log entry reported a lost fixture, blank
fallback, failed adoption, or handoff stream error. The size reduction between
the two handoffs is not a transfer discrepancy: the snapshots were captured
about fifteen hours apart and represent bounded, changing terminal state.

The recovery helper restarted cleanly during the handoff and was PID 60285 at
inspection. Its latest fixture file had sequence 2,867,741, 120x42 geometry,
and 168,920 serialized characters. That recovery sequence is the recovery
stream position, not the live daemon snapshot sequence. The controls had no
same-name recovery JSON when checked; because they were new/current-stage
sessions, this absence was not treated as evidence of loss.

### Daemon versus server/KSP

A correctly byte-buffered direct daemon `Snapshot` and a KSP `term_snapshot`
captured at the same quiet fixture state were identical:

```text
length 225025
sha256 f71aa86fb1ab964693796700a80e4a14ed3baf6bd7d9b06890f9581b44efba23
geometry 120x42
```

An earlier diagnostic probe incorrectly concatenated Node `Buffer` objects
into a string before framing, decoding UTF-8 independently at chunk boundaries.
It produced a false three-byte discrepancy and replacement characters. Repeating
the probe with `Buffer.concat()`, locating the newline as bytes, and decoding
once eliminated the discrepancy. This was diagnostic parser corruption, not a
Kanna observation.

The staging server log contained one warned fixture KSP send stall on Aug 14
(526 ms, 1,368 bytes) followed by recovery. There was no targeted terminal
stream loss, daemon-loss, or terminal Error warning. Normal frames are not all
logged, so this only excludes logged faults; it does not prove that the browser
rendered every frame.

### Snapshot content and live redraws

Fresh replay of all three snapshots selected the normal screen; the alternate
buffer was empty. The newer `a75212da` control had more serialized bytes and
more buffer rows than the fixture. Accumulated daemon snapshot size therefore
does not explain the fixture concentration on its own.

A five-second passive KSP output sample found the fixture quiet. The controls
each produced about 46-48 KiB in roughly 200 chunks, with 144-145 synchronized
output enter/exit pairs, about 1,000 erase-line sequences, about 1,300 cursor
positions, and no alternate-screen enter/exit. High-frequency normal-screen
cursor redraw is normal for fresh Codex controls and is not fixture-specific.

The current desktop log recorded 36 `startListening` operations for the
fixture and 32 selections into it. The same retained component id was observed
across rapid tab-away/tab-back cycles, with a fresh attach and resize on every
return. The newer `42ab0ffe` control had six starts/selections; `a75212da` had
not been opened in that logged WebView. The fixture also dominated logged
background-throttling/pending-write warnings (maximum 1,647 chunks / 349,789
bytes pending). The warnings later recovered and do not prove byte loss, but
they show the retained fixture experiencing substantially more replay and queue
pressure. At a checkpoint before the final hash probes, the current daemon had
58 fixture `attach_snapshot` entries; four were read-only diagnostic attaches
from this investigation. Its two earlier daemon generations had 18 and 20.

### Deterministic shipped-xterm reproduction

The exact live KSP snapshots were replayed in Chromium using the desktop's
installed `@xterm/xterm` 6.1.0-beta.195. For each task the harness recorded a
fresh one-shot replay, replayed the same snapshot again without reset (the
current Codex reconnect behavior), then reset and replayed once:

| Task | One shot | Same snapshot twice | Reset + one shot |
|---|---|---|---|
| `aed228ac` | 2,362 rows, hash `e7aba91` | 4,721 rows, hash `58576895` | 2,362 rows, hash `e7aba91` |
| `a75212da` | 2,853 rows, hash `1045e899` | 5,703 rows, hash `4cdb4f63` | 2,853 rows, hash `1045e899` |
| `42ab0ffe` | 586 rows, hash `2ffe0f4a` | 1,169 rows, hash `98460590` | 586 rows, hash `2ffe0f4a` |

For the fixture, non-empty rows doubled from 1,888 to 3,776. The twice-replayed
tail still matched the snapshot tail, explaining why the reproduction proves
retained-history divergence but does not deterministically recreate the exact
reported stale bottom fragment. Reflow, viewport anchoring, a different live
snapshot, pending output, or alternate-screen state is the remaining condition
needed to turn the accumulation into that particular rendered frame.

## Skipped checks and exact missing prerequisites

- The raw PTY master was not read: doing so would consume bytes and mutate the
  fixture. The daemon does not retain historical raw PTY output. Proving a
  historical fixture escape sequence requires a passive raw-output tap captured
  before fanout or a disposable controlled reproduction.
- A 35-second passive KSP observation attempt ended without a usable captured
  fixture frame and is not evidence. The successful five-second quiet sample is
  the only fixture live-output result reported above.
- The staging WebView exposes no enabled read-only hook for the live xterm's
  buffer, viewport, selection, parser state, or active screen. Direct comparison
  of the already-corrupt live grid requires such an inspection hook or a captured
  trace that can be replayed into the shipped xterm.
- macOS privacy denied this shell access to the referenced Desktop screenshot.
  Reinspection requires attaching the image to the task/session or granting the
  process Desktop access. The user's description of that screenshot was not
  silently upgraded into a new observation.
- Provider composer placeholders found in terminal/log output were treated as
  Codex UI chrome, never as submitted input.
- No resize/reflow experiment, tab switch, alternate-screen transition, input,
  recovery, restart, or handoff was induced on the fixture.

## Evidence from exhausted task `cf1b5371`

This task was inspected only after the independent trace above. Its review
history supports the need for replacement semantics but rejects its attempted
mechanism:

- resetting a live terminal without fencing pending writes and attachment
  generations races old and new state and harms viewport/selection behavior;
- RIS (`ESC c`) does not establish all serializer assumptions and regressed
  modes such as kitty keyboard state and saved cursor/charset state;
- the later clear-scrollback/clear-active/home prefix clears only the currently
  active buffer, so a retained alternate screen can preserve stale primary
  state before a serialized alternate snapshot switches screens;
- its epoch filter silently dropped epoch-less current server Error frames;
- fake-terminal tests did not establish capacity, reflow, alternate-screen,
  selection, or real-xterm correctness.

Nothing from that branch should be cherry-picked as the fix.

## Smallest architecture options for review

Preferred: treat an authoritative snapshot as a transaction into a fresh,
identically configured xterm/model. Queue that attachment's live frames until
the snapshot write callback completes, then atomically swap it into the view.
Retire every older attachment's snapshot/output/status/exit/error frames. UI
state such as bottom pinning, manual viewport, and selection may be restored
only when its content identity is still valid. This matches the serializer's
fresh-terminal assumption and avoids guessing a sufficient VT reset prefix.

Larger alternative: make snapshots a versioned structured replacement contract
that explicitly represents primary and alternate buffers, active screen,
cursor/modes, scrollback, and compatibility with older peers. A normal-screen
clear/reset fast path is safe only when protocol metadata proves its preconditions;
it is not a complete general solution.

Acceptance criteria for either design:

1. Applying an identical snapshot N times produces the same buffer length,
   active screen, grid, and hash as one fresh replay; scrollback never grows.
2. Raw-output oracle, daemon snapshot, KSP frame, and shipped desktop xterm
   agree at fixed and resized widths, including split UTF-8 boundaries.
3. Primary-to-primary, retained-alternate-to-primary, and alternate snapshots
   carrying both primary and alternate content all restore the correct buffers,
   active screen, modes, cursor, and alternate exit behavior.
4. Snapshot readiness includes xterm's asynchronous write completion. No older
   attachment can deliver snapshot/output/status/exit/error afterward; current
   epoch-less compatibility frames, especially Error, are handled explicitly
   rather than silently discarded.
5. Repeated KeepAlive switches, KSP reconnects, and daemon handoffs preserve a
   bottom-pinned view, preserve a manual viewport when its content survives,
   and discard invalid selection after trim/reflow without stale cells.
6. Tests use the real shipped xterm at its 10,024-row capacity and exercise
   reflow, queue pressure, synchronized output, and alternate screens. An E2E
   covers the real daemon -> server/KSP -> desktop boundary.
7. The reported rendered-frame symptom is reproduced with a disposable
   long-running Codex session or a passive staging trace, never by mutating
   `aed228ac`.

## Command record

The material read-only commands are recorded below. MCP calls were
`kanna_info {}` and `kanna_get_task {"task_id":"<id>"}` for `aed228ac`,
`a75212da`, `42ab0ffe`, `14282f67`, and, after the independent trace,
`cf1b5371`.

```sh
pwd && git status --short --branch && printf 'task=%s\n' "$KANNA_TASK_ID"
ps -axo pid,ppid,lstart,tty,command | rg 'Kanna|kanna|codex|aed228ac|a75212da|42ab0ffe'
lsof -nP -iTCP:48121 -sTCP:LISTEN
lsof -nU | rg '/tmp/kanna-2d7beacd.sock'
find "$HOME/Library/Application Support/build.kanna.staging/Kanna" -maxdepth 3 -type f -print | sort
rg -n 'aed228ac|a75212da|42ab0ffe|handoff|Handoff|attach_snapshot|terminal_snapshot|websocket_send' \
  "$HOME/Library/Application Support/build.kanna.staging/Kanna/logs" /tmp/kanna-webview-58c79e45.log
rg -c 'request=attach_snapshot.*task_id=aed228ac' \
  "$HOME/Library/Application Support/build.kanna.staging/Kanna/logs"/*.log
rg -n 'aed228ac|a75212da|42ab0ffe' \
  "$HOME/Library/Application Support/build.kanna.staging/Kanna/terminal-recovery"
```

Source tracing used:

```sh
rg -n 'TerminalSnapshot|AttachSnapshot|Snapshot|emulate_terminal|snapshot' crates/daemon crates/kanna-server packages/stream-client apps/desktop/src
sed -n '1,260p' crates/daemon/src/headless_terminal.rs
sed -n '1,280p' crates/daemon/src/connection.rs
sed -n '3480,3735p' crates/kanna-server/src/ksp.rs
sed -n '1,280p' apps/desktop/src/composables/terminalSessionLifecycle.ts
sed -n '1,240p' apps/desktop/src/components/terminal/TerminalTabs.vue
sed -n '1,260p' apps/desktop/src/composables/useTerminal.ts
git blame -L 80,100 -- apps/desktop/src/composables/terminalSessionLifecycle.ts
git show --stat --oneline 7c9dda70ab
```

The KSP probes opened `ws://127.0.0.1:48121/v1/stream`, sent the following
frames, and never sent `term_input` or `term_resize`:

```json
{"type":"auth","capabilities":[]}
{"type":"attach","task_id":"aed228ac","kind":"terminal","from_seq":0}
```

The same attach was repeated with task ids `a75212da` and `42ab0ffe` for the
control snapshots and five-second passive output samples. Direct daemon
comparison connected to `/tmp/kanna-2d7beacd.sock` and wrote exactly:

```json
{"type":"Snapshot","task_id":"aed228ac"}
```

It accumulated socket chunks with `Buffer.concat(chunks)`, split on the first
byte `0x0a`, parsed that JSON line, decoded `vt` from base64, and compared
length and SHA-256 with the KSP frame. The replay harness launched Chromium
through `tests/tui-fidelity/node_modules/playwright`, loaded
`apps/desktop/node_modules/@xterm/xterm/lib/xterm.js`, and invoked xterm
`write(snapshot, callback)` for one-shot, duplicate, and reset/one-shot cases.
Its hash covered active-buffer type, dimensions, base/viewport/cursor values,
and every translated buffer row.

The replay defect can be checked without touching the PTY beyond the same
read-only snapshot attach. This is the reduced form of the executed harness;
success means `one.rows < twice.rows` and `one` equals `resetOnce`:

```sh
NODE_PATH=tests/tui-fidelity/node_modules node <<'NODE'
const { chromium } = require('playwright');
const path = require('node:path');

function getSnapshot(taskId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:48121/v1/stream');
    ws.onerror = event => reject(event.error ?? new Error('WebSocket error'));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', capabilities: [] }));
    };
    ws.onmessage = event => {
      const frame = JSON.parse(event.data);
      if (frame.type === 'auth_ok') {
        ws.send(JSON.stringify({
          type: 'attach', task_id: taskId, kind: 'terminal', from_seq: 0,
        }));
      }
      if (frame.type === 'term_snapshot' && frame.task_id === taskId) {
        ws.close();
        resolve({
          vt: Buffer.from(frame.data_b64, 'base64').toString('utf8'),
          rows: frame.rows,
          cols: frame.cols,
        });
      }
    };
  });
}

async function main() {
  const snapshot = await getSnapshot('aed228ac');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addScriptTag({
    path: path.resolve('apps/desktop/node_modules/@xterm/xterm/lib/xterm.js'),
  });
  const result = await page.evaluate(async snapshot => {
    const terminal = new window.Terminal({
      cols: snapshot.cols, rows: snapshot.rows, scrollback: 10000,
    });
    const write = vt => new Promise(resolve => terminal.write(vt, resolve));
    const inspect = () => {
      const buffer = terminal.buffer.active;
      const lines = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
      }
      return {
        rows: buffer.length,
        active: buffer.type,
        grid: JSON.stringify(lines),
      };
    };
    await write(snapshot.vt);
    const one = inspect();
    await write(snapshot.vt);
    const twice = inspect();
    terminal.reset();
    await write(snapshot.vt);
    const resetOnce = inspect();
    return {
      one: { rows: one.rows, active: one.active },
      twice: { rows: twice.rows, active: twice.active },
      resetOnce: { rows: resetOnce.rows, active: resetOnce.active },
      resetMatchesOne: one.grid === resetOnce.grid,
    };
  }, snapshot);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
NODE
```

At 19:51 JST the reduced command was re-run against control `a75212da` to
validate the documented harness without adding another fixture observer. Its
then-current snapshot produced 346 rows once, 689 twice, and 346 after
reset/once, with identical one-shot and reset/once grids. The control's state
had changed since the earlier 2,853-row capture; the replacement/idempotence
result did not. A preceding harness check used the wrong UMD constructor name
(`window.Terminal.Terminal`) and stopped after obtaining the control snapshot,
before replay. A dependency-only check also tried `require('ws')`, which is not
installed in that package scope; the final command correctly uses Node 24's
built-in WebSocket. Neither discarded check contributes to the evidence table.

Screenshot access was attempted with:

```sh
find /Users/jeremyhale/Desktop -maxdepth 1 -name 'Screenshot 2026-08-15 at 5.58.16*' -print
```

It returned `Operation not permitted`. One discarded Node process probe also
used the shell variable name `path`, which is special in zsh and temporarily
broke command lookup inside that subprocess; the corrected probe used
`proc_path`. Neither discarded probe contributed an observation.
