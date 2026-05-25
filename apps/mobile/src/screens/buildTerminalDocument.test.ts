import { describe, expect, it } from "vitest";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalReplaceScript
} from "./buildTerminalDocument";

describe("buildTerminalDocument", () => {
  it("builds an xterm shell with sticky scroll behavior and bottom inset", () => {
    const html = buildTerminalDocument({
      bottomInset: 132
    });

    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('id="viewport"');
    expect(html).toContain('id="terminal-root"');
    expect(html).toContain("padding-bottom: 132px;");
    expect(html).toContain("overflow-x: auto;");
    expect(html).toContain("const TERMINAL_COLS = 220;");
    expect(html).toContain("term.resize(TERMINAL_COLS, proposed.rows)");
    expect(html).toContain("const term = new TerminalCtor(");
    expect(html).toContain("new FitAddonCtor()");
    expect(html).toContain("term.open(root)");
    expect(html).toContain("term.scrollToBottom()");
    expect(html).toContain("window.__replaceTerminalState");
    expect(html).toContain("window.__appendTerminalChunk");
    expect(html).toContain("window.ReactNativeWebView.postMessage");
    expect(html).toContain('type: "terminal-ready"');
    expect(html).toContain("terminalViewport.style.bottom = stickyToBottom");
    expect(html).not.toContain("<pre id=\"terminal\"></pre>");
  });

  it("repairs utf-8 box drawing text that arrived as latin-1 mojibake in replace scripts", () => {
    const script = buildTerminalReplaceScript({
      output: "â­ââ Claude Code âââ®",
      status: "live"
    });

    expect(script).toContain("╭── Claude Code ──╮");
    expect(script).not.toContain("â­");
    expect(script).toContain("window.__replaceTerminalState");
  });

  it("repairs utf-8 spinner text that arrived as latin-1 mojibake in append scripts", () => {
    const script = buildTerminalAppendScript("â  Thinking\n");

    expect(script).toContain("⠋ Thinking\\n");
    expect(script).not.toContain("â ");
  });

  it("renders terminal status copy when no output is available", () => {
    const connectingScript = buildTerminalReplaceScript({
      output: "",
      status: "connecting"
    });
    const idleScript = buildTerminalReplaceScript({
      output: "   ",
      status: "idle"
    });

    expect(connectingScript).toContain("Connecting to desktop daemon...");
    expect(idleScript).toContain("Waiting for terminal output...");
  });

  it("builds append scripts for incremental terminal output", () => {
    const script = buildTerminalAppendScript("Second line\n");

    expect(script).toContain("window.__appendTerminalChunk");
    expect(script).toContain("Second line\\n");
  });
});
