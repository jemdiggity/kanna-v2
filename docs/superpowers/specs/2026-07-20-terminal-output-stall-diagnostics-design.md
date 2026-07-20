# Terminal Output Stall Diagnostics Design

## Context

Agent terminal output occasionally stops updating for as long as twenty seconds. Earlier work reduced frontend listener and polling overhead, but the long pauses remain intermittent and the available measurements cannot identify their source.

The current terminal path crosses five independently scheduled boundaries:

1. the agent process writes to its PTY;
2. the daemon reads, mirrors, persists, and fans out each chunk;
3. the local Kanna server reads daemon events and queues KSP frames;
4. the WebSocket delivers frames to the shared stream client;
5. the WebView decodes output and xterm processes and renders it.

The existing frontend metrics count invokes and listener registrations. Daemon benchmarks measure synthetic headless-terminal replay and status extraction. Neither records live per-boundary latency, queue backpressure, browser event-loop stalls, or xterm backlog. Several daemon and KSP output operations also await downstream consumers without a timeout or a timing record, so a slow consumer can suspend PTY ingestion without leaving evidence that identifies the blocked stage.

## Goals

- Make every active processing stall of at least 500 milliseconds and every output gap of at least two seconds leave enough evidence to identify its boundary.
- Distinguish agent/PTY source silence from daemon processing, daemon client fanout, KSP queueing, WebSocket delivery, WebView event-loop delay, and xterm backlog.
- Persist sufficient structured diagnostics to investigate intermittent stalls in installed builds.
- Keep monitoring state and normal-path overhead bounded.
- Add deterministic probes for the suspected backpressure paths.
- Change terminal behavior only if a deterministic regression test proves a specific blocking cause.

## Non-goals

- Do not record terminal contents, command text, prompts, credentials, or other payload data.
- Do not add a diagnostics UI or remote telemetry service.
- Do not alter KSP frame schemas solely to carry timing metadata.
- Do not use wall-clock differences as cross-process latency measurements.
- Do not redesign the entire daemon fanout architecture without a reproducing test.

## Approaches considered

### Frontend watchdog only

A browser event-loop and xterm monitor would detect visible freezes with a small patch. It could not distinguish a WebView stall from delayed or absent upstream frames, so it would still leave the primary question unanswered.

### Backend timing only

Daemon and KSP spans would reveal socket and queue backpressure but could not detect synchronous WebView work, timer starvation, or xterm's write backlog. A healthy backend trace would still not explain a frozen visible terminal.

### Layered stall classifier

Instrument every scheduling and queue boundary with local monotonic timing, then correlate thresholded structured records by wall-clock time and session identity. This is the selected approach because it can identify both upstream and frontend stalls without adding continuous payload telemetry or cross-process clock assumptions.

## Design

### Diagnostic record

Slow-path records use a stable `terminal_perf` prefix and fields suitable for text-log searching:

- `at_ms`: wall-clock Unix milliseconds for approximate cross-process correlation;
- `session_id` and, where available, `task_id`;
- `stage`: the local processing boundary;
- `event`: `stall`, `recovered`, or `gap`;
- `duration_ms`: monotonic duration measured within the emitting process;
- `chunk`, `bytes`, `pending_chunks`, `pending_bytes`, and queue capacity where applicable.

No record contains output bytes or decoded text. Wall-clock time correlates files only; each duration is computed from one process's monotonic clock.

The slow-stage threshold is 500 milliseconds. A source/output gap is recorded when output resumes after at least two seconds. Gap records are supporting observations; the earliest matching active-stage stall is the primary cause. Repeated reports for one session and stage are rate-limited, followed by one recovery summary when the stage becomes healthy.

### Daemon monitor

The daemon assigns each PTY output chunk a per-session local sequence number and tracks the previous read and completed-processing instants. It measures these stages separately:

- state/headless-terminal lock acquisition and output mirroring;
- status detection and status-event work;
- each attached terminal client write;
- recovery mirroring;
- observer writes;
- snapshot serialization and the state-lock wait that precedes it.

A per-process watchdog scans the current stage of each active terminal stream on a fixed interval. It reports a stall when a stage remains active for 500 milliseconds and reports recovery when the operation completes. The output path only updates bounded stage state before and after each operation; it does not allocate a timer per chunk. The watchdog does not impose a timeout or cancel work.

When the next PTY chunk arrives after two seconds, the daemon reports the inter-read gap. If the previous chunk had a recorded downstream stall, the record names that stage as the prior blocker. Otherwise the gap is classified as PTY source silence, which distinguishes an agent that emitted nothing from output that the daemon could not finish processing.

### KSP server monitor

The terminal attachment task records when it receives a daemon output event and measures admission to the shared ordinary-frame queue. The server watchdog reports an `outbound_queue` stage that remains active for 500 milliseconds, including the task, session, frame size, available capacity, and configured capacity.

The WebSocket writer measures frame serialization and socket sends independently. This separates server CPU work from transport backpressure. Diagnostics remain local logs; terminal frames and KSP protocol types do not gain timing fields.

### WebView monitor

The shared stream client stamps terminal-frame dispatch with `performance.now()` and passes local receive metadata to the terminal handler without changing the wire protocol. The terminal monitor records:

- frame receipt and decoded byte size;
- base64 decode duration;
- xterm write enqueue time;
- xterm write completion callback time;
- pending chunks and bytes.

An event-loop watchdog compares expected and actual timer execution while at least one terminal attachment is active. Drift over 500 milliseconds emits `event_loop` with the current terminal backlog and last frame/write times. Drift while the document is hidden is classified as background throttling rather than a visible terminal stall.

Frontend warnings use the existing console forwarding, which persists them through `append_log` in installed Tauri builds. The monitor keeps only counters and latest timestamps per attached terminal. Detach removes that state and stops the watchdog when no terminals remain.

### Proven-fix gate

Instrumentation is behavior-neutral. It neither times out, cancels, retries, drops, nor reorders terminal output.

A deterministic daemon integration probe attaches a healthy reader and a deliberately non-reading client to one chatty PTY. If the non-reading client prevents the healthy client from receiving output, that failing test proves consumer backpressure can freeze PTY ingestion. Only then will this task implement the smallest correct consumer-isolation change and keep the probe as its regression test.

If the probe does not reproduce a stall, this task stops at observability rather than speculating about a fix.

## Failure handling and overhead

- Diagnostic failures never fail or delay terminal processing.
- Monitoring helpers swallow their own errors after one warning.
- State is bounded to per-session counters, timestamps, and rate-limit state; output payloads and unbounded histories are never retained.
- Warnings are emitted only after thresholds and are rate-limited during a continuing stall.
- Recovery summaries close the diagnostic episode without logging every healthy chunk.
- Hidden-document timer drift cannot be reported as a visible WebView freeze.
- Instrumentation does not change existing recovery, reconnect, snapshot, status-detection, or terminal-emulation semantics.

## Testing

### Daemon

- Unit-test the slow-operation classifier at threshold boundaries, rate limiting, recovery summaries, source gaps, and bounded state.
- Add the chatty-PTY integration probe with one consuming and one non-reading attached client.
- If the probe fails against current behavior, keep it red until the isolated-consumer implementation makes the healthy client responsive without output corruption.

### KSP server

- Use a deliberately tiny outbound channel with a held receiver to prove a blocked terminal frame is reported as `outbound_queue`.
- Hold the socket sink independently to prove WebSocket send delay is classified separately.
- Verify ordinary fast frames do not produce diagnostic records.

### Frontend

- Hold xterm write callbacks and advance fake timers to produce `xterm_backlog` with the expected pending counts.
- Advance the event-loop watchdog while visible and hidden to verify `event_loop` and background-throttling classification.
- Verify terminal state is removed on detach and the watchdog stops with no attachments.
- Verify diagnostic records contain counts and durations but not decoded output.

### End to end

- Extend the real-PTY terminal performance test with continuously numbered output and a maximum observed output-gap assertion.
- Verify normal multi-terminal streaming produces no false stall warnings.
- Block the browser main thread through a controlled E2E hook and verify the persisted frontend diagnostic identifies `event_loop` rather than an upstream transport stage.
- Run the existing scrollback and recovery suites to ensure xterm completion callbacks and monitoring do not change terminal fidelity.

## Acceptance criteria

- Every injected stall emits the expected primary-boundary record; downstream gap observations may accompany it without being classified as additional causes.
- Normal streaming remains below thresholds and produces no persistent stall warnings.
- Monitor memory is bounded by active terminal/session count.
- No terminal content appears in diagnostic records.
- Terminal output order and bytes remain unchanged by instrumentation.
- Any behavioral fix included in this task is backed by the deterministic slow-consumer regression test.
