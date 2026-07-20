const WATCHDOG_INTERVAL_MS = 250
const STALL_THRESHOLD_MS = 500
const STALL_REPEAT_MS = 10_000
const FRAME_GAP_THRESHOLD_MS = 2_000

export type TerminalOutputPerfEventKind = "stall" | "recovered" | "gap"

export interface TerminalOutputPerfEvent {
  atMs: number
  component: "webview"
  sessionId: string
  stage: "frame_dispatch" | "frame_gap" | "base64_decode" | "xterm_backlog" | "event_loop" | "background_throttling"
  event: TerminalOutputPerfEventKind
  durationMs: number
  bytes: number
  pendingChunks: number
  pendingBytes: number
}

export interface TerminalOutputPerfSnapshot {
  activeSessions: number
  maxFrameGapMs: number
  maxEventLoopDriftMs: number
  maxXtermBacklogMs: number
  pendingChunks: number
  pendingBytes: number
  latestEvent: TerminalOutputPerfEvent | null
}

export interface TerminalOutputPerfHandle {
  frameReceived(receivedAtMs: number, encodedBytes: number): void
  recordDecode(durationMs: number, decodedBytes: number): void
  beginXtermWrite(bytes: number): () => void
  dispose(): void
}

interface SessionPerfState {
  sessionId: string
  references: number
  lastFrameAt: number | null
  latestBytes: number
  pendingChunks: number
  pendingBytes: number
  backlogStartedAt: number | null
  xtermStalled: boolean
  lastXtermReportAt: number | null
  eventLoopStage: "event_loop" | "background_throttling" | null
  eventLoopStallDurationMs: number
  lastEventLoopReportAt: number | null
}

interface TerminalOutputPerfDependencies {
  now: () => number
  wallNow: () => number
  visibility: () => "visible" | "hidden"
  warn: (record: string) => void
  setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
}

export class TerminalOutputPerfRegistry {
  private readonly dependencies: TerminalOutputPerfDependencies
  private readonly sessions = new Map<string, SessionPerfState>()
  private watchdog: ReturnType<typeof setInterval> | null = null
  private nextWatchdogAt = 0
  private maxFrameGapMs = 0
  private maxEventLoopDriftMs = 0
  private maxXtermBacklogMs = 0
  private latestEvent: TerminalOutputPerfEvent | null = null

  constructor(dependencies: Partial<TerminalOutputPerfDependencies> = {}) {
    this.dependencies = {
      now: dependencies.now ?? (() => performance.now()),
      wallNow: dependencies.wallNow ?? (() => Date.now()),
      visibility: dependencies.visibility ?? (() =>
        typeof document !== "undefined" && document.visibilityState === "hidden"
          ? "hidden"
          : "visible"),
      warn: dependencies.warn ?? ((record) => console.warn(record)),
      setInterval: dependencies.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs)),
      clearInterval: dependencies.clearInterval ?? ((timer) => clearInterval(timer)),
    }
  }

  attach(sessionId: string): TerminalOutputPerfHandle {
    let state = this.sessions.get(sessionId)
    if (state) {
      state.references += 1
    } else {
      state = {
        sessionId,
        references: 1,
        lastFrameAt: null,
        latestBytes: 0,
        pendingChunks: 0,
        pendingBytes: 0,
        backlogStartedAt: null,
        xtermStalled: false,
        lastXtermReportAt: null,
        eventLoopStage: null,
        eventLoopStallDurationMs: 0,
        lastEventLoopReportAt: null,
      }
      this.sessions.set(sessionId, state)
    }
    this.startWatchdog()

    let disposed = false
    return {
      frameReceived: (receivedAtMs, encodedBytes) => {
        if (disposed) return
        this.frameReceived(state, receivedAtMs, encodedBytes)
      },
      recordDecode: (durationMs, decodedBytes) => {
        if (disposed) return
        this.recordCompletedStage(state, "base64_decode", durationMs, decodedBytes)
      },
      beginXtermWrite: (bytes) => {
        if (disposed) return () => {}
        return this.beginXtermWrite(state, bytes, () => disposed)
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        state.references -= 1
        if (state.references <= 0) {
          this.sessions.delete(sessionId)
        }
        this.stopWatchdogIfIdle()
      },
    }
  }

  poll(): void {
    if (this.sessions.size === 0) return
    const now = this.dependencies.now()
    const driftMs = Math.max(0, now - this.nextWatchdogAt)
    this.nextWatchdogAt = now + WATCHDOG_INTERVAL_MS
    this.maxEventLoopDriftMs = Math.max(this.maxEventLoopDriftMs, driftMs)

    for (const state of this.sessions.values()) {
      this.pollEventLoop(state, now, driftMs)
      this.pollXtermBacklog(state, now)
    }
  }

  snapshot(): TerminalOutputPerfSnapshot {
    let pendingChunks = 0
    let pendingBytes = 0
    for (const state of this.sessions.values()) {
      pendingChunks += state.pendingChunks
      pendingBytes += state.pendingBytes
    }
    return {
      activeSessions: this.sessions.size,
      maxFrameGapMs: this.maxFrameGapMs,
      maxEventLoopDriftMs: this.maxEventLoopDriftMs,
      maxXtermBacklogMs: this.maxXtermBacklogMs,
      pendingChunks,
      pendingBytes,
      latestEvent: this.latestEvent ? { ...this.latestEvent } : null,
    }
  }

  resetSnapshot(): void {
    this.maxFrameGapMs = 0
    this.maxEventLoopDriftMs = 0
    this.maxXtermBacklogMs = 0
    this.latestEvent = null
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return
    this.nextWatchdogAt = this.dependencies.now() + WATCHDOG_INTERVAL_MS
    this.watchdog = this.dependencies.setInterval(() => this.poll(), WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdogIfIdle(): void {
    if (this.sessions.size !== 0 || this.watchdog === null) return
    this.dependencies.clearInterval(this.watchdog)
    this.watchdog = null
    this.nextWatchdogAt = 0
  }

  private frameReceived(state: SessionPerfState, receivedAtMs: number, encodedBytes: number): void {
    const now = this.dependencies.now()
    const dispatchDurationMs = Math.max(0, now - receivedAtMs)
    state.latestBytes = encodedBytes
    this.recordCompletedStage(state, "frame_dispatch", dispatchDurationMs, encodedBytes)

    if (state.lastFrameAt !== null) {
      const gapMs = Math.max(0, receivedAtMs - state.lastFrameAt)
      this.maxFrameGapMs = Math.max(this.maxFrameGapMs, gapMs)
      if (gapMs >= FRAME_GAP_THRESHOLD_MS) {
        this.emit(state, "frame_gap", "gap", gapMs, encodedBytes)
      }
    }
    state.lastFrameAt = receivedAtMs
  }

  private recordCompletedStage(
    state: SessionPerfState,
    stage: "frame_dispatch" | "base64_decode",
    durationMs: number,
    bytes: number,
  ): void {
    if (durationMs < STALL_THRESHOLD_MS) return
    this.emit(state, stage, "stall", durationMs, bytes)
    this.emit(state, stage, "recovered", durationMs, bytes)
  }

  private beginXtermWrite(
    state: SessionPerfState,
    bytes: number,
    isDisposed: () => boolean,
  ): () => void {
    const startedAt = this.dependencies.now()
    if (state.pendingChunks === 0) {
      state.backlogStartedAt = startedAt
    }
    state.pendingChunks += 1
    state.pendingBytes += bytes
    let completed = false
    return () => {
      if (completed) return
      completed = true
      state.pendingChunks = Math.max(0, state.pendingChunks - 1)
      state.pendingBytes = Math.max(0, state.pendingBytes - bytes)
      if (state.pendingChunks !== 0) return

      const durationMs = state.backlogStartedAt === null
        ? 0
        : Math.max(0, this.dependencies.now() - state.backlogStartedAt)
      this.maxXtermBacklogMs = Math.max(this.maxXtermBacklogMs, durationMs)
      if (!isDisposed() && state.xtermStalled) {
        this.emit(state, "xterm_backlog", "recovered", durationMs, bytes)
      }
      state.backlogStartedAt = null
      state.xtermStalled = false
      state.lastXtermReportAt = null
    }
  }

  private pollXtermBacklog(state: SessionPerfState, now: number): void {
    if (state.backlogStartedAt === null || state.pendingChunks === 0) return
    const durationMs = Math.max(0, now - state.backlogStartedAt)
    this.maxXtermBacklogMs = Math.max(this.maxXtermBacklogMs, durationMs)
    if (durationMs < STALL_THRESHOLD_MS) return
    if (state.lastXtermReportAt !== null && now - state.lastXtermReportAt < STALL_REPEAT_MS) return
    state.xtermStalled = true
    state.lastXtermReportAt = now
    this.emit(state, "xterm_backlog", "stall", durationMs, state.latestBytes)
  }

  private pollEventLoop(state: SessionPerfState, now: number, driftMs: number): void {
    if (driftMs >= STALL_THRESHOLD_MS) {
      const stage = this.dependencies.visibility() === "hidden"
        ? "background_throttling"
        : "event_loop"
      const shouldReport = state.eventLoopStage !== stage
        || state.lastEventLoopReportAt === null
        || now - state.lastEventLoopReportAt >= STALL_REPEAT_MS
      state.eventLoopStage = stage
      state.eventLoopStallDurationMs = driftMs
      if (shouldReport) {
        state.lastEventLoopReportAt = now
        this.emit(state, stage, "stall", driftMs, state.latestBytes)
      }
      return
    }

    if (state.eventLoopStage) {
      this.emit(
        state,
        state.eventLoopStage,
        "recovered",
        state.eventLoopStallDurationMs,
        state.latestBytes,
      )
      state.eventLoopStage = null
      state.eventLoopStallDurationMs = 0
      state.lastEventLoopReportAt = null
    }
  }

  private emit(
    state: SessionPerfState,
    stage: TerminalOutputPerfEvent["stage"],
    event: TerminalOutputPerfEventKind,
    durationMs: number,
    bytes: number,
  ): void {
    const record: TerminalOutputPerfEvent = {
      atMs: this.dependencies.wallNow(),
      component: "webview",
      sessionId: state.sessionId,
      stage,
      event,
      durationMs: Math.round(durationMs),
      bytes,
      pendingChunks: state.pendingChunks,
      pendingBytes: state.pendingBytes,
    }
    this.latestEvent = record
    this.dependencies.warn(formatTerminalOutputPerfEvent(record))
  }
}

export function formatTerminalOutputPerfEvent(event: TerminalOutputPerfEvent): string {
  return [
    "terminal_perf",
    `at_ms=${event.atMs}`,
    `component=${event.component}`,
    `session_id=${event.sessionId}`,
    `stage=${event.stage}`,
    `event=${event.event}`,
    `duration_ms=${event.durationMs}`,
    `bytes=${event.bytes}`,
    `pending_chunks=${event.pendingChunks}`,
    `pending_bytes=${event.pendingBytes}`,
  ].join(" ")
}

const globalTerminalOutputPerf = new TerminalOutputPerfRegistry()

export function attachTerminalOutputPerf(sessionId: string): TerminalOutputPerfHandle {
  return globalTerminalOutputPerf.attach(sessionId)
}

export function getTerminalOutputPerfSnapshot(): TerminalOutputPerfSnapshot {
  return globalTerminalOutputPerf.snapshot()
}

export function resetTerminalOutputPerfSnapshot(): void {
  globalTerminalOutputPerf.resetSnapshot()
}
