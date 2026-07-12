import { describe, expect, it } from "vitest";
import { scriptedAgentSource } from "./scriptedAgent";

describe("scripted remote E2E agent", () => {
  it("uses a POSIX shell shebang so task shells do not need to resolve node", () => {
    expect(scriptedAgentSource().startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("replays readiness for observers that attach after the first PTY chunk", () => {
    const source = scriptedAgentSource();

    expect(source).toContain("printf 'SCRIPT_READY\\n'");
    expect(source).toContain("sleep 0.25");
    expect(source).toContain("heartbeat=$((heartbeat + 1))");
    expect(source).toContain("[ $((heartbeat % 4)) -eq 0 ]");
  });

  it("simulates a menu whose cursor starts on the second option", () => {
    const source = scriptedAgentSource();

    expect(source).toContain("SCRIPT_MENU_CURSOR:2");
    expect(source).toContain("SCRIPT_MENU_OPTION_1_HIGHLIGHTED");
    expect(source).toContain("SCRIPT_MENU_SELECTED:1");
    expect(source).toContain("stty -icanon min 1 time 0 -echo -icrnl");
  });

  it("keeps stdin open and exits deterministically on submitted scripted input", () => {
    const source = scriptedAgentSource();

    expect(source).toContain("read_char()");
    expect(source).toContain("SCRIPT_INPUT:%s");
    expect(source).toContain("*exit-zero*)");
    expect(source).toContain("*exit-one*)");
    expect(source).toContain("wait \"$heartbeat_pid\"");
  });
});
