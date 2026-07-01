import { describe, expect, it } from "vitest";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";

function b64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

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
    expect(html).toContain("-webkit-overflow-scrolling: touch;");
    expect(html).toContain("touch-action: pan-x pan-y;");
    expect(html).toContain("terminalViewport.style.overflowX = \"visible\"");
    expect(html).toContain("const TERMINAL_COLS = 220;");
    expect(html).toContain("term.resize(TERMINAL_COLS, proposed.rows)");
    expect(html).toContain("const term = new TerminalCtor(");
    expect(html).toContain("vtExtensions: { kittyKeyboard: true }");
    expect(html).toContain("new FitAddonCtor()");
    expect(html).toContain("term.open(root)");
    expect(html).toContain("term.scrollToBottom()");
    expect(html).toContain("window.__replaceTerminalState");
    expect(html).toContain("window.__appendTerminalChunk");
    expect(html).toContain("window.ReactNativeWebView.postMessage");
    expect(html).toContain('type: "terminal-ready"');
    expect(html).toContain('type: "terminal-tap"');
    expect(html).toContain('viewport.addEventListener("pointerdown"');
    expect(html).toContain("terminalViewport.style.bottom = stickyToBottom");
    expect(html).not.toContain("<pre id=\"terminal\"></pre>");
  });

  it("writes base64 terminal chunks as bytes in replace scripts", () => {
    const script = buildTerminalReplaceScript({
      output: `${b64("╭── Claude Code ──╮")}\n`,
      status: "live"
    });

    expect(script).toContain(b64("╭── Claude Code ──╮"));
    expect(script).not.toContain("╭── Claude Code ──╮");
    expect(script).not.toContain("â­");
    expect(script).toContain("window.__replaceTerminalState");
    expect(script).toContain("chunksB64");
  });

  it("preserves split multibyte terminal chunks in append scripts", () => {
    const script = buildTerminalAppendScript("8J8=\nmIA=\n");

    expect(script).toContain("8J8=");
    expect(script).toContain("mIA=");
    expect(script).not.toContain("😀");
    expect(script).toContain("window.__appendTerminalChunk");
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
    const script = buildTerminalAppendScript(`${b64("Second line\n")}\n`);

    expect(script).toContain("window.__appendTerminalChunk");
    expect(script).toContain(b64("Second line\n"));
    expect(script).not.toContain("Second line");
  });

  it("keeps large newline-delimited base64 snapshot frames as separate chunks", () => {
    const firstFrame = "A".repeat(64_000);
    const secondFrame = b64("terminal prompt\n");
    const script = buildTerminalReplaceScript({
      output: `${firstFrame}\n${secondFrame}\n`,
      status: "live"
    });

    expect(script).toContain(`"chunksB64":["${firstFrame}","${secondFrame}"]`);
    expect(script).not.toContain(`${firstFrame}\\n${secondFrame}`);
  });

  it("builds resize scripts for the WebView terminal dimension bridge", () => {
    const html = buildTerminalDocument({ bottomInset: 24 });
    const script = buildTerminalResizeScript(132, 43);

    expect(html).toContain("window.__setTerminalDims");
    expect(html).toContain("term.resize(pinnedCols, pinnedRows)");
    expect(html).toContain("root.dataset.kannaCols = String(pinnedCols)");
    expect(html).toContain("root.dataset.kannaRows = String(pinnedRows)");
    expect(html).toContain("root.dataset.kannaFrameCount");
    expect(html).toContain("new TextDecoder");
    expect(html).toContain("applyPinnedSize()");
    expect(script).toBe('window.__setTerminalDims({"cols":132,"rows":43}); true;');
  });

  it("keeps echoed terminal input control stripping in the webview byte path", () => {
    const html = buildTerminalDocument({ bottomInset: 24 });
    const replaceScript = buildTerminalReplaceScript({
      output: `${b64("\u001b[200~continue\u001b[201~\u001b[13u\nClaude response\n")}\n`,
      status: "live"
    });
    const appendScript = buildTerminalAppendScript(`${b64("\u001b[>1u\u001b[13;5u")}\n`);

    expect(html).toContain("removeEchoedTerminalInputControls");
    expect(replaceScript).toContain(b64("\u001b[200~continue\u001b[201~\u001b[13u\nClaude response\n"));
    expect(replaceScript).not.toContain("[200~");
    expect(replaceScript).not.toContain("[201~");
    expect(replaceScript).not.toContain("[13u");
    expect(appendScript).not.toContain("[>1u");
    expect(appendScript).not.toContain("[13;5u");
  });
});
