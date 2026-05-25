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
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        padding-bottom: ${bottomInset}px;
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

      term.loadAddon(fitAddon);
      term.open(root);

      function syncViewport() {
        const nextViewport = root.querySelector(".xterm-viewport");
        if (!nextViewport || nextViewport === terminalViewport) {
          return;
        }

        terminalViewport = nextViewport;
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

      function fitTerminal() {
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
        } catch (_error) {
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

      window.__replaceTerminalState = function replaceTerminalState(state) {
        const shouldStick = stickyToBottom || isNearBottom();
        term.reset();
        fitTerminal();
        term.write(state.text, () => {
          fitTerminal();
          finalizeRender(shouldStick);
        });
      };

      window.__appendTerminalChunk = function appendTerminalChunk(state) {
        if (!state.text) {
          return;
        }

        const shouldStick = stickyToBottom || isNearBottom();
        term.write(state.text, () => {
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
  const terminalText = output.trim() ? normalizeTerminalText(output) : getStatusCopy(status);
  return `window.__replaceTerminalState(${JSON.stringify({ text: terminalText })}); true;`;
}

export function buildTerminalAppendScript(chunk: string): string {
  return `window.__appendTerminalChunk(${JSON.stringify({
    text: normalizeTerminalText(chunk)
  })}); true;`;
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

function normalizeTerminalText(input: string): string {
  if (!looksLikeMojibake(input)) {
    return input;
  }

  const normalized = new TextDecoder("utf-8", { fatal: false }).decode(
    Uint8Array.from(input, (char) => char.charCodeAt(0) & 0xff)
  );

  if (containsTerminalGlyphs(normalized)) {
    return normalized;
  }

  return mojibakeScore(normalized) < mojibakeScore(input) ? normalized : input;
}

function looksLikeMojibake(input: string): boolean {
  return input.includes("â") || input.includes("ð") || input.includes("Ã");
}

function containsTerminalGlyphs(input: string): boolean {
  return /[╭╮╰╯│─┌┐└┘├┤┬┴┼⠁-⣿]/u.test(input);
}

function mojibakeScore(input: string): number {
  const matches = input.match(/[âÃð][\u0080-\u00bf]?|�/gu);
  return matches ? matches.length : 0;
}
