import { describe, expect, it, vi } from "vitest";
import { TerminalOutputPerfRegistry } from "./terminalOutputPerf";

function testRegistry(visibility: "visible" | "hidden" = "visible") {
  let now = 0;
  const warnings: string[] = [];
  const interval = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
  const clearInterval = vi.fn();
  const registry = new TerminalOutputPerfRegistry({
    now: () => now,
    wallNow: () => 1_721_526_400_000 + now,
    visibility: () => visibility,
    warn: (record) => warnings.push(record),
    setInterval: interval,
    clearInterval,
  });
  return {
    registry,
    warnings,
    interval,
    clearInterval,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("TerminalOutputPerfRegistry", () => {
  it("reports a held xterm write at 500ms and one recovery on completion", () => {
    const test = testRegistry();
    const terminal = test.registry.attach("session-xterm");
    const complete = terminal.beginXtermWrite(4096);

    test.setNow(499);
    test.registry.poll();
    expect(test.warnings).toEqual([]);

    test.setNow(500);
    test.registry.poll();
    expect(test.warnings.at(-1)).toContain("stage=xterm_backlog");
    expect(test.warnings.at(-1)).toContain("event=stall");
    expect(test.warnings.at(-1)).toContain("pending_chunks=1");
    expect(test.warnings.at(-1)).toContain("pending_bytes=4096");

    test.setNow(750);
    complete();
    complete();
    expect(test.warnings.at(-1)).toContain("event=recovered");
    expect(test.registry.snapshot()).toMatchObject({
      pendingChunks: 0,
      pendingBytes: 0,
      maxXtermBacklogMs: 750,
    });
  });

  it("classifies delayed watchdog ticks by document visibility", () => {
    const visible = testRegistry("visible");
    visible.registry.attach("session-visible");
    visible.setNow(750);
    visible.registry.poll();
    expect(visible.warnings.at(-1)).toContain("stage=event_loop");
    expect(visible.registry.snapshot().maxEventLoopDriftMs).toBe(500);

    const hidden = testRegistry("hidden");
    hidden.registry.attach("session-hidden");
    hidden.setNow(750);
    hidden.registry.poll();
    expect(hidden.warnings.at(-1)).toContain("stage=background_throttling");
    expect(hidden.warnings.at(-1)).not.toContain("stage=event_loop ");
  });

  it("reports resumed frame gaps and never retains terminal payloads", () => {
    const test = testRegistry();
    const terminal = test.registry.attach("session-gap");
    const encodedSecret = "VE9QX1NFQ1JFVF9URVJNSU5BTF9QQVlMT0FE";

    terminal.frameReceived(0, encodedSecret.length);
    test.setNow(2_000);
    terminal.frameReceived(2_000, encodedSecret.length);

    expect(test.warnings.at(-1)).toContain("stage=frame_gap");
    expect(test.warnings.at(-1)).toContain("event=gap");
    expect(test.warnings.join("\n")).not.toContain(encodedSecret);
    expect(JSON.stringify(test.registry.snapshot())).not.toContain(encodedSecret);
  });

  it("stops the watchdog when the last terminal detaches", () => {
    const test = testRegistry();
    const first = test.registry.attach("session-one");
    const second = test.registry.attach("session-two");
    expect(test.interval).toHaveBeenCalledOnce();

    first.dispose();
    expect(test.clearInterval).not.toHaveBeenCalled();
    second.dispose();

    expect(test.clearInterval).toHaveBeenCalledOnce();
    expect(test.registry.snapshot().activeSessions).toBe(0);
  });
});
