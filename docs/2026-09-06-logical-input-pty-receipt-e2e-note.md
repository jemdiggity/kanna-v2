# Logical-message PTY receipt: what the incident was, and what now covers it

Task eb296b63 investigated the 2026-09-06 incident in which a 1,047-byte
single-line manager message was accepted by the daemon, recorded whole in the
durable input ledger, answered `ok` — and reached the recipient as its last 25
bytes only.

## What was measured

A macOS PTY master accepts 1,022 bytes per write. Reproduced against a real
daemon and a real PTY, an unframed 1,047-byte write splits into exactly
1,022 + 25 bytes, and the 25-byte remainder is the fragment the recipient
quoted back. The deployed build was `v0.3.0-staging.10` (`a561d48d`), whose
`frame_logical_message` bracketed a message only when it contained CR or LF, so
a long single-line message was written unframed and the queue boundary became
the CLI's input-event boundary. `fe98eca1` (PR #1314, merged to `main`
2026-09-05, after that tag) frames any message of at least 256 bytes, which is
what makes the split survivable. The incident is therefore already fixed on
`main`; it requires a staging build cut from `main` at or after `fe98eca1`.

Claude Code 2.1.263, captured in a throwaway PTY: `ESC[?2004h` is emitted 19
bytes into its first output, toggled off and on once more inside the first
second of terminal capability negotiation, and never disabled again across the
rest of a session. The framing path is therefore live for Claude sessions after
startup.

## Coverage that runs

`crates/daemon/tests/reconnect.rs` gains a durable stdin-receipt fixture: a
`perl` process on the far side of a real PTY that records the exact bytes its
stdin delivered and the size of every read, with a paced reader so the kernel's
split lands on a fixed boundary instead of a scheduling race. Rendered output
and terminal echo cannot answer this question — they describe what the emulator
drew, not what the process read.

Against that fixture, and asserted byte for byte: the queue split itself; a
long single-line message arriving as one paste region with exactly one Enter as
its own input event; a character cut in half by the boundary; multiline; the
256-byte framing threshold from both sides; bracketed-paste mode absent; a
repainting composer; a terminal that never settles (Enter withheld, caller told,
the next message refused rather than concatenated); a stale session incarnation;
and a concurrent human draft.

What this adds over what already existed is narrower than it looks, and worth
stating exactly. Reverting `frame_logical_message` to the `v0.3.0-staging.10`
behaviour fails the three long-message tests here — but it also already fails
`session::tests::a_long_single_line_message_is_framed_as_one_paste`, a unit test
that shipped with #1314. The framing *decision* was covered. What was not is the
layer below it: under the same revert the entire pre-existing real-daemon,
real-PTY suite passes (54 tests, none failing). A unit test proves the daemon
decides to wrap the bytes; it does not prove the process on the far side of a
real PTY receives all 1,047 of them as one input event with exactly one Enter,
which is the part that failed in production.

## Coverage through the full path

`tests/remote-e2e/src/terminal-flow.e2e.test.ts` gains
`delivers a long single-line logical message whole and submits it exactly once`,
which drives the same payload through the real path — HTTP `POST
/v1/tasks/{id}/input`, the server, the daemon, a real PTY agent — and asserts
the agent's own NUL-delimited input trace file equals the message exactly, with
one `task_input` row and nothing behind it. That leg is what the incident
actually exercised: the MCP/HTTP hop answered `ok:true` while the recipient held
a fragment, and the daemon tests above do not touch it.

It passes, observed 2026-09-07: twice on the `terminal-flow` spec alone
(`✓ delivers a long single-line logical message whole and submits it exactly
once`, 4574ms), and again inside `./kd test remote-e2e`, whose sequential runner
only reaches the fifth spec if the third one passed. 4.6s sits against the
test's own 20s trace deadline.
That margin is worth knowing because this test is the first end-to-end consumer
of the `inputTraceFile` plumbing in `tests/remote-e2e/src/scriptedAgent.ts`,
whose reader forks `dd bs=1 count=1` per byte and had never been driven with a
1,047-byte payload. The scripted agent runs non-canonical
(`stty -icanon min 1 time 0`), so the 1,024-byte `MAX_CANON` ceiling that would
otherwise bound a single line does not apply to it.

An earlier revision of this note deferred that run: at this branch's base
(`7e8e066e`) the whole remote-e2e lane could not start, because `waitForHttpOk`
in `tests/remote-e2e/src/processes.ts` polled `/v1/status` with bare `fetch` and
Node 24's undici stamps every request with `sec-fetch-mode: cors`, which
`lan_trust.rs` refuses as browser-originated. That line now calls
`localProcessFetch`, so merging `origin/main` into this branch was enough to
make the lane start.

The lane as a whole still exits 1, on a spec this branch does not touch.
`tests/remote-e2e/src/lan-layer.e2e.test.ts` fails 11 tests, most of them 403
`browser requests must present this desktop's local control credential`. Its
`nodeFetch` at line 742 is still `async (input, init) => fetch(input, init)` —
the same bare-`fetch` shape that was fixed in `processes.ts` but not here, even
though this file already imports `localProcessFetch` and uses it in one other
place. That line is byte-identical on `origin/main`, and this branch's entire
delta from `origin/main` is three files (a daemon test, the `terminal-flow`
spec, and this note) with no product code, so the failure is inherited rather
than caused. Converting `nodeFetch` looks like one line, but several of the 11
failures are snapshot timeouts rather than 403s, so the WebSocket side may need
the credential too; that is its own task, not this one.

## The contract, stated rather than overclaimed

The daemon guarantees that every byte of a logical message reaches the PTY, in
order, followed by exactly one Enter written only after the terminal settles.
It does not control the consumer's `read` boundaries. When the application has
enabled bracketed-paste mode, the in-band markers make those boundaries
irrelevant: a consumer that implements the protocol rejoins the pieces into one
editor operation. When the application never advertised the mode, the daemon
cannot send the markers — they would land at the composer as literal text — and
the split remains the consumer's input-event boundary. That case is asserted as
a limit, not a guarantee, in
`without_bracketed_paste_mode_a_long_message_is_whole_but_the_split_remains`.
