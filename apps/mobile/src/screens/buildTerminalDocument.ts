import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  XTERM_WEBVIEW_CSS,
  XTERM_WEBVIEW_FIT_ADDON_SCRIPT,
  XTERM_WEBVIEW_SCRIPT
} from "./xtermWebViewAssets.generated";

interface BuildTerminalDocumentOptions {
  bottomInset: number;
}

interface BuildTerminalUpdateScriptOptions {
  output: string;
  status: TaskTerminalStatus;
}

export function buildTerminalDocument({ bottomInset }: BuildTerminalDocumentOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=yes"
    />
    <style>
      ${XTERM_WEBVIEW_CSS}

      :root {
        color-scheme: dark;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        height: 100%;
      }

      body {
        margin: 0;
        background: #09111d;
        color: #dfe9f7;
        -webkit-text-size-adjust: 100%;
        overflow: hidden;
      }

      .viewport {
        -webkit-overflow-scrolling: touch;
        height: 100%;
        overflow-x: auto;
        overflow-y: auto;
        padding-bottom: ${bottomInset}px;
        touch-action: pan-x pan-y;
      }

      #terminal-root {
        height: 100%;
        min-width: 1760px;
        width: 100%;
      }

      .xterm {
        height: 100%;
      }

      .xterm,
      .xterm .xterm-screen,
      .xterm .xterm-viewport {
        background: transparent !important;
      }

      .xterm .xterm-viewport {
        overscroll-behavior: contain;
        touch-action: pan-y;
      }
    </style>
  </head>
  <body>
    <div class="viewport" id="viewport">
      <div id="terminal-root"></div>
    </div>
    <script>${XTERM_WEBVIEW_SCRIPT}</script>
    <script>${XTERM_WEBVIEW_FIT_ADDON_SCRIPT}</script>
    <script>
      const root = document.getElementById("terminal-root");
      const viewport = document.getElementById("viewport");
      const TerminalCtor = globalThis.Terminal;
      const FitAddonCtor = globalThis.FitAddon && globalThis.FitAddon.FitAddon;
      const TERMINAL_COLS = 220;
      const term = new TerminalCtor({
        cols: TERMINAL_COLS,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1,
        letterSpacing: 0,
        cursorBlink: false,
        scrollback: 10000,
        vtExtensions: { kittyKeyboard: true },
        theme: {
          background: "#09111d",
          foreground: "#dfe9f7",
          cursor: "#7dd3fc",
          selectionBackground: "#18324d",
          black: "#000000",
          red: "#ff7a90",
          green: "#7ce38b",
          yellow: "#f4d35e",
          blue: "#7dd3fc",
          magenta: "#c4b5fd",
          cyan: "#67e8f9",
          white: "#f8fafc",
          brightBlack: "#5b6b83",
          brightRed: "#ff9ab0",
          brightGreen: "#9ef0a8",
          brightYellow: "#ffe08a",
          brightBlue: "#9fe2ff",
          brightMagenta: "#ddd6fe",
          brightCyan: "#a5f3fc",
          brightWhite: "#ffffff"
        }
      });
      const fitAddon = new FitAddonCtor();
      let terminalViewport = null;
      let stickyToBottom = true;
      let pinnedCols = 0;
      let pinnedRows = 0;

      term.loadAddon(fitAddon);
      term.open(root);

      function syncViewport() {
        const nextViewport = root.querySelector(".xterm-viewport");
        if (!nextViewport || nextViewport === terminalViewport) {
          return;
        }

        terminalViewport = nextViewport;
        terminalViewport.style.overflowX = "visible";
        applyViewportInset();

        if (terminalViewport.dataset.kannaScrollBound !== "1") {
          terminalViewport.dataset.kannaScrollBound = "1";
          terminalViewport.addEventListener(
            "scroll",
            () => {
              stickyToBottom = isNearBottom();
              applyViewportInset();
            },
            { passive: true }
          );
        }
      }

      function applyViewportInset() {
        if (!terminalViewport) {
          return;
        }

        terminalViewport.style.bottom = stickyToBottom ? "${bottomInset}px" : "0px";
      }

      function cellDimensions() {
        try {
          const cell = term._core._renderService.dimensions.css.cell;
          if (cell && cell.width && cell.height) {
            return { width: cell.width, height: cell.height };
          }
        } catch (_error) {
          // Render service not ready yet; fall back to an estimate.
        }
        return { width: 8, height: 17 };
      }

      function applyPinnedSize() {
        if (!pinnedCols || !pinnedRows) {
          return;
        }
        const { width, height } = cellDimensions();
        root.style.minWidth = "0px";
        root.style.width = Math.ceil(pinnedCols * width) + "px";
        root.style.height = Math.ceil(pinnedRows * height) + "px";
      }

      window.__setTerminalDims = function setTerminalDims(dims) {
        if (!dims || !dims.cols || !dims.rows) {
          return;
        }
        pinnedCols = dims.cols;
        pinnedRows = dims.rows;
        try {
          term.resize(pinnedCols, pinnedRows);
        } catch (_error) {
          // Resize can throw mid-layout; a later call will retry.
        }
        applyPinnedSize();
        syncViewport();
      };

      function fitTerminal() {
        // Once the desktop PTY dimensions are known, render at exactly that grid
        // (current font, scroll on overflow) instead of refitting to the device.
        if (pinnedCols && pinnedRows) {
          applyPinnedSize();
          syncViewport();
          return;
        }
        try {
          const proposed = fitAddon.proposeDimensions();
          if (proposed) {
            term.resize(TERMINAL_COLS, proposed.rows);
          } else {
            fitAddon.fit();
            if (term.cols < TERMINAL_COLS) {
              term.resize(TERMINAL_COLS, term.rows);
            }
          }
          root.style.width = Math.max(
            viewport.clientWidth,
            TERMINAL_COLS * 8
          ) + "px";
          syncViewport();
        } catch {
          // WebView layout is still settling. The next resize tick will retry.
        }
      }

      function isNearBottom() {
        if (!terminalViewport) {
          return true;
        }

        const distanceFromBottom =
          terminalViewport.scrollHeight -
          terminalViewport.clientHeight -
          terminalViewport.scrollTop;
        return distanceFromBottom <= 24;
      }

      requestAnimationFrame(() => {
        fitTerminal();
        requestAnimationFrame(() => {
          fitTerminal();
          term.scrollToBottom();
        });
      });

      window.addEventListener("resize", () => {
        fitTerminal();
        if (stickyToBottom) {
          applyViewportInset();
          term.scrollToBottom();
        }
      });

      function finalizeRender(shouldStick) {
        stickyToBottom = shouldStick;
        applyViewportInset();

        if (shouldStick) {
          term.scrollToBottom();
        }
      }

      function notifyReady() {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "terminal-ready" }));
      }

      function notifyTerminalTap() {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "terminal-tap" }));
      }

      viewport.addEventListener("pointerdown", notifyTerminalTap, { passive: true });

      function base64ToBytes(dataB64) {
        try {
          const binary = atob(dataB64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        } catch (_error) {
          return new Uint8Array(0);
        }
      }

      function matchesByteSequence(bytes, offset, sequence) {
        if (offset + sequence.length > bytes.length) {
          return false;
        }
        for (let index = 0; index < sequence.length; index += 1) {
          if (bytes[offset + index] !== sequence[index]) {
            return false;
          }
        }
        return true;
      }

      function echoedInputControlLength(bytes, offset) {
        if (matchesByteSequence(bytes, offset, [27, 91, 50, 48, 48, 126])) {
          return 6;
        }
        if (matchesByteSequence(bytes, offset, [27, 91, 50, 48, 49, 126])) {
          return 6;
        }
        if (bytes[offset] !== 27 || bytes[offset + 1] !== 91) {
          return 0;
        }

        let index = offset + 2;
        if (bytes[index] === 62) {
          index += 1;
        }
        const digitsStart = index;
        while (
          index < bytes.length &&
          ((bytes[index] >= 48 && bytes[index] <= 57) || bytes[index] === 59)
        ) {
          index += 1;
        }
        if (index === digitsStart || bytes[index] !== 117) {
          return 0;
        }
        return index - offset + 1;
      }

      function removeEchoedTerminalInputControls(bytes) {
        const output = [];
        for (let index = 0; index < bytes.length;) {
          const controlLength = echoedInputControlLength(bytes, index);
          if (controlLength > 0) {
            index += controlLength;
            continue;
          }
          output.push(bytes[index]);
          index += 1;
        }
        return Uint8Array.from(output);
      }

      function writeTerminalChunks(chunksB64, done) {
        const chunks = Array.isArray(chunksB64) ? chunksB64 : [];
        let index = 0;

        function writeNext() {
          if (index >= chunks.length) {
            done();
            return;
          }
          const bytes = removeEchoedTerminalInputControls(base64ToBytes(chunks[index]));
          index += 1;
          if (bytes.length === 0) {
            writeNext();
            return;
          }
          term.write(bytes, writeNext);
        }

        writeNext();
      }

      window.__replaceTerminalState = function replaceTerminalState(state) {
        const shouldStick = stickyToBottom || isNearBottom();
        term.reset();
        fitTerminal();
        const complete = () => {
          fitTerminal();
          finalizeRender(shouldStick);
        };
        if (state.text) {
          term.write(state.text, complete);
          return;
        }
        writeTerminalChunks(state.chunksB64, complete);
      };

      window.__appendTerminalChunk = function appendTerminalChunk(state) {
        if (!state.chunksB64 || state.chunksB64.length === 0) {
          return;
        }

        const shouldStick = stickyToBottom || isNearBottom();
        writeTerminalChunks(state.chunksB64, () => {
          fitTerminal();
          finalizeRender(shouldStick);
        });
      };

      requestAnimationFrame(() => {
        notifyReady();
      });
    </script>
  </body>
</html>`;
}

export function buildTerminalReplaceScript({
  output,
  status
}: BuildTerminalUpdateScriptOptions): string {
  const state = output.trim()
    ? { chunksB64: terminalChunksFromOutput(output) }
    : { text: getStatusCopy(status) };
  return `window.__replaceTerminalState(${JSON.stringify(state)}); true;`;
}

export function buildTerminalAppendScript(chunk: string): string {
  return `window.__appendTerminalChunk(${JSON.stringify({
    chunksB64: terminalChunksFromOutput(chunk)
  })}); true;`;
}

export function buildTerminalResizeScript(cols: number, rows: number): string {
  return `window.__setTerminalDims(${JSON.stringify({ cols, rows })}); true;`;
}

function getStatusCopy(status: TaskTerminalStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting to desktop daemon...";
    case "error":
      return "Terminal stream failed.";
    case "closed":
      return "Terminal session closed.";
    case "idle":
    case "live":
    default:
      return "Waiting for terminal output...";
  }
}

function terminalChunksFromOutput(output: string): string[] {
  return output
    .split("\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}
