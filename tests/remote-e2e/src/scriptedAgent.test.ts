import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeScriptedAgentBinary, scriptedAgentSource } from "./scriptedAgent";

async function observeSubmittedInput(input: string): Promise<string> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "kanna-scripted-agent-"));
  const fixturePath = join(fixtureDir, "codex");

  try {
    await writeScriptedAgentBinary(fixturePath);
    const fixture = spawn(fixturePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    fixture.stdout.setEncoding("utf8");
    const expectedMarker = `SCRIPT_INPUT:${input}\n`;
    const observed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        fixture.kill("SIGKILL");
        reject(new Error(`scripted agent did not observe exact input; output:\n${output}`));
      }, 5_000);
      fixture.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes(expectedMarker)) {
          clearTimeout(timeout);
          fixture.kill("SIGKILL");
          resolve();
        }
      });
      fixture.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      fixture.once("exit", (code, signal) => {
        if (!output.includes(expectedMarker)) {
          clearTimeout(timeout);
          reject(
            new Error(
              `scripted agent exited ${String(code)} (${String(signal)}); output:\n${output}`,
            ),
          );
        }
      });
    });
    fixture.stdin.write(`${input}\r`);
    await observed;

    return output;
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

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

  it("preserves embedded line feeds while observing one submitted PTY input", async () => {
    const input = "SGTM. Proceed.\n\nPreserve the relay fixture.";
    const output = await observeSubmittedInput(input);

    expect(output.match(/SCRIPT_INPUT:/g)).toHaveLength(1);
    expect(output).toContain(`SCRIPT_INPUT:${input}\n`);
  });
});
