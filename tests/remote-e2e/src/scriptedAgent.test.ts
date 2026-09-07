import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scriptedClaudeStatusAgentSource,
  writeScriptedAgentBinary,
  scriptedAgentSource,
  type ScriptedAgentOptions,
} from "./scriptedAgent";

async function observeSubmittedInput(
  input: string,
  options: ScriptedAgentOptions = {},
  terminalBytes = `${input}\r`,
): Promise<string> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "kanna-scripted-agent-"));
  const fixturePath = join(fixtureDir, "codex");

  try {
    await writeScriptedAgentBinary(fixturePath, options);
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
    fixture.stdin.write(terminalBytes);
    await observed;

    return output;
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

describe("scripted remote E2E agent", () => {
  it("paints Claude busy and idle frames with the measured composer footer", () => {
    const source = scriptedClaudeStatusAgentSource();

    expect(source).toContain("esc to interrupt");
    expect(source).toContain("SCRIPT_CLAUDE_IDLE");
    expect(source).toContain("❯ ");
    expect(source).toContain("bypass permissions on");
  });

  it("reaches the waiting and exited runtime verdicts from sentinel input", () => {
    const source = scriptedClaudeStatusAgentSource();

    // The exact marker `headless_terminal.rs` classifies as Waiting.
    expect(source).toContain("Do you want to allow this command?");
    expect(source).toContain("*ask-permission*");
    expect(source).toContain("*quit-now*");
  });

  it("can prime a retained terminal snapshot with a unique final sentinel", () => {
    const configurableSource = scriptedAgentSource as unknown as (options: {
      snapshotHistory: { sentinel: string };
    }) => string;
    const source = configurableSource({
      snapshotHistory: { sentinel: "MOBILE_PTY_SNAPSHOT_SENTINEL" },
    });

    expect(source).toContain('history_line -le 10050');
    expect(source).toContain("MOBILE_PTY_HISTORY_%05d_");
    expect(source).toContain("MOBILE_PTY_SNAPSHOT_SENTINEL");
    expect(source).toContain(
      'if [ "$snapshot_history_enabled" -eq 1 ]; then\n' +
        "        printf '%s\\n' 'MOBILE_PTY_SNAPSHOT_SENTINEL'",
    );
  });

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
    expect(source).toContain("SCRIPT_INPUT_READY");
    expect(source).toContain("SCRIPT_MENU_OPTION_1_HIGHLIGHTED");
    expect(source).toContain("SCRIPT_MENU_SELECTED:1");
    expect(source).toContain("stty -icanon min 1 time 0 -echo -icrnl");
  });

  it("can durably record multiline input outside the rendered window", () => {
    const source = scriptedAgentSource({ inputTraceFile: ".kanna-e2e-inputs" });

    expect(source).toContain(
      `printf '%s\\000' "$line" >> '.kanna-e2e-inputs'`,
    );
  });

  it("keeps stdin open and exits deterministically on submitted scripted input", () => {
    const source = scriptedAgentSource();

    expect(source).toContain("read_char()");
    expect(source).toContain("SCRIPT_INPUT:%s");
    expect(source).toContain("*exit-zero*)");
    expect(source).toContain("*exit-one*)");
    expect(source).toContain("*burst-output*)");
    expect(source).toContain("burst_line -le 2000");
    expect(source).toContain("wait \"$heartbeat_pid\"");
  });

  it("can consume sensitive input without returning its bytes to observers", () => {
    const source = scriptedAgentSource({ redactInput: true });

    expect(source).toContain("SCRIPT_REDACTED_INPUT");
    expect(source).not.toContain("SCRIPT_INPUT:%s");
    expect(source.indexOf("stty -icanon min 1 time 0 -echo -icrnl")).toBeLessThan(
      source.indexOf("SCRIPT_INPUT_READY")
    );
  });

  it("preserves embedded line feeds while observing one submitted PTY input", async () => {
    const input = "SGTM. Proceed.\n\nPreserve the relay fixture.";
    const output = await observeSubmittedInput(input);

    expect(output.match(/SCRIPT_INPUT:/g)).toHaveLength(1);
    expect(output).toContain(`SCRIPT_INPUT:${input}\n`);
  });

  it("models bracketed paste boundaries for multiline terminal input", async () => {
    const input = "Commit the relevant work.\n\nPrevious implementation result:";
    const output = await observeSubmittedInput(
      input,
      { terminalPasteSemantics: true },
      `\u001b[200~${input}\u001b[201~\r`,
    );

    expect(output.match(/SCRIPT_INPUT:/g)).toHaveLength(1);
    expect(output).toContain(`SCRIPT_INPUT:${input}\n`);
    expect(output).not.toContain("[200~");
    expect(output).not.toContain("[201~");
  });
});
