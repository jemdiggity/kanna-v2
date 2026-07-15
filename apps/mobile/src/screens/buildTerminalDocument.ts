import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  XTERM_WEBVIEW_CSS,
  XTERM_WEBVIEW_FIT_ADDON_SCRIPT,
  XTERM_WEBVIEW_SCRIPT
} from "./xtermWebViewAssets.generated";

interface BuildTerminalDocumentOptions {
  bottomInset: number;
  enableE2EInspection: boolean;
}

interface BuildTerminalUpdateScriptOptions {
  output: string;
  status: TaskTerminalStatus;
}

const TERMINAL_FILE_PATH_PATTERN =
  /(?:^|[\s"'`(<\[])(\/?[a-zA-Z0-9_.\-][\w.\-/]*\.[a-zA-Z][a-zA-Z0-9]*(?::\d+){0,2})/g.source;

export function buildTerminalDocument({
  bottomInset,
  enableE2EInspection
}: BuildTerminalDocumentOptions): string {
  const initialBottomInset = Number.isFinite(bottomInset)
    ? Math.max(0, Math.ceil(bottomInset))
    : 0;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=3, user-scalable=yes"
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
        padding-bottom: ${initialBottomInset}px;
        touch-action: pan-x pan-y pinch-zoom;
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
      #terminal-root,
      .xterm .xterm-screen,
      .xterm .xterm-viewport,
      .xterm .xterm-scrollable-element {
        background: transparent !important;
        touch-action: pan-x pan-y pinch-zoom;
      }

      .xterm .xterm-screen,
      .xterm .xterm-viewport,
      .xterm .xterm-scrollable-element {
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
      const BASE_FONT_SIZE = 13;
      const MIN_FONT_SCALE = 0.75;
      const MAX_FONT_SCALE = 1.8;
      const SMOOTH_SCROLL_DURATION_MS = 80;
      const term = new TerminalCtor({
        cols: TERMINAL_COLS,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: BASE_FONT_SIZE,
        lineHeight: 1,
        letterSpacing: 0,
        cursorBlink: false,
        scrollback: 10000,
        smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
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
      let bottomInset = ${initialBottomInset};
      let stickyToBottom = true;
      let pinnedCols = 0;
      let pinnedRows = 0;
      let fontScale = 1;
      let touchScroll = null;
      let pinch = null;

      term.loadAddon(fitAddon);
      term.open(root);
      term.onScroll(() => {
        stickyToBottom = isNearBottom();
      });

      const terminalFilePathRegex = new RegExp(
        ${JSON.stringify(TERMINAL_FILE_PATH_PATTERN)},
        "g"
      );

      function parseTerminalFileLink(raw) {
        const parts = raw.split(":");
        const suffixes = [];
        while (parts.length > 1 && suffixes.length < 2) {
          const maybeNumber = parts[parts.length - 1];
          if (!maybeNumber || !/^\\d+$/.test(maybeNumber)) {
            break;
          }
          suffixes.unshift(Number.parseInt(maybeNumber, 10));
          parts.pop();
        }

        const path = parts.join(":");
        if (path.split("/").includes("..")) {
          return null;
        }
        return { path, line: suffixes[0] };
      }

      function notifyTerminalFileLink(path, line) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        const message = { type: "terminal-file-link", path };
        if (line !== undefined) {
          message.line = line;
        }
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function terminalCellBoundaries(line) {
        const boundaries = new Map([[0, 0]]);
        let stringOffset = 0;
        for (let cellColumn = 0; cellColumn < line.length; cellColumn += 1) {
          const cell = line.getCell(cellColumn);
          if (!cell) continue;
          const width = cell.getWidth();
          if (width === 0) continue;
          const chars = cell.getChars() || " ";
          boundaries.set(stringOffset, cellColumn);
          stringOffset += chars.length;
          boundaries.set(stringOffset, cellColumn + width);
        }
        return boundaries;
      }

      function detectTerminalFileLinks(lineText, bufferLineNumber, line) {
        const links = [];
        const cellBoundaries = terminalCellBoundaries(line);
        terminalFilePathRegex.lastIndex = 0;
        let match;
        while ((match = terminalFilePathRegex.exec(lineText)) !== null) {
          const raw = match[1];
          const parsed = parseTerminalFileLink(raw);
          if (!parsed) {
            continue;
          }
          const start = match.index + match[0].length - raw.length;
          const startCell = cellBoundaries.get(start);
          const endCell = cellBoundaries.get(start + raw.length);
          if (startCell === undefined || endCell === undefined) {
            continue;
          }
          links.push({
            range: {
              start: { x: startCell + 1, y: bufferLineNumber },
              end: { x: endCell, y: bufferLineNumber }
            },
            text: raw,
            decorations: {
              pointerCursor: true,
              underline: true
            },
            activate() {
              notifyTerminalFileLink(parsed.path, parsed.line);
            }
          });
        }
        return links;
      }

      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = term.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const links = detectTerminalFileLinks(
            line.translateToString(true),
            bufferLineNumber,
            line
          );
          callback(links.length ? links : undefined);
        }
      });

      function cellDimensions() {
        const cell = term.dimensions && term.dimensions.css.cell;
        if (cell && cell.width && cell.height) {
          return { width: cell.width, height: cell.height };
        }
        return { width: 8, height: 17 };
      }

      function alignViewportToSafeRegion() {
        viewport.scrollTop = Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight
        );
      }

      function scheduleViewportAlignment() {
        alignViewportToSafeRegion();
        requestAnimationFrame(alignViewportToSafeRegion);
      }

      function applyBottomInset() {
        viewport.style.paddingBottom = bottomInset + "px";
        root.dataset.kannaBottomInset = String(bottomInset);
        scheduleViewportAlignment();
      }

      function applyPinnedSize() {
        if (!pinnedCols || !pinnedRows) {
          return;
        }
        const { width, height } = cellDimensions();
        root.style.minWidth = "0px";
        root.style.width = Math.ceil(pinnedCols * width) + "px";
        root.style.height = Math.ceil(pinnedRows * height) + "px";
        root.dataset.kannaCols = String(pinnedCols);
        root.dataset.kannaRows = String(pinnedRows);
      }

      window.__setTerminalDims = function setTerminalDims(dims) {
        if (!dims || !dims.cols || !dims.rows) {
          return;
        }
        const shouldStick = stickyToBottom || isNearBottom();
        pinnedCols = dims.cols;
        pinnedRows = dims.rows;
        try {
          term.resize(pinnedCols, pinnedRows);
        } catch (_error) {
          // Resize can throw mid-layout; a later call will retry.
        }
        applyPinnedSize();
        scheduleViewportAlignment();
        stickyToBottom = shouldStick;
        if (shouldStick) {
          scrollToBottomImmediately();
        }
      };

      window.__setTerminalBottomInset = function setTerminalBottomInset(state) {
        const nextBottomInset = Number(state && state.bottomInset);
        if (!Number.isFinite(nextBottomInset)) {
          return;
        }
        const shouldStick = stickyToBottom || isNearBottom();
        bottomInset = Math.max(0, Math.ceil(nextBottomInset));
        applyBottomInset();
        fitTerminal();
        stickyToBottom = shouldStick;
        if (shouldStick) {
          scrollToBottomImmediately();
        }
        scheduleViewportAlignment();
      };

      function fitTerminal() {
        // Once the desktop PTY dimensions are known, render at exactly that grid
        // (current font, scroll on overflow) instead of refitting to the device.
        if (pinnedCols && pinnedRows) {
          applyPinnedSize();
          scheduleViewportAlignment();
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
          scheduleViewportAlignment();
        } catch {
          // WebView layout is still settling. The next resize tick will retry.
        }
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function touchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
      }

      function scrollToBottomImmediately() {
        const smoothScrollDuration = term.options.smoothScrollDuration;
        term.options.smoothScrollDuration = 0;
        try {
          term.scrollToBottom();
        } finally {
          term.options.smoothScrollDuration = smoothScrollDuration;
        }
      }

      function applyFontScale(nextScale) {
        const shouldStick = stickyToBottom || isNearBottom();
        fontScale = clamp(nextScale, MIN_FONT_SCALE, MAX_FONT_SCALE);
        term.options.fontSize = Math.round(BASE_FONT_SIZE * fontScale);
        root.dataset.kannaFontScale = fontScale.toFixed(2);
        fitTerminal();
        stickyToBottom = shouldStick;
        if (shouldStick) {
          scrollToBottomImmediately();
        }
      }

      function installPinchZoomFallback() {
        viewport.addEventListener("touchstart", (event) => {
          if (event.touches.length === 2) {
            pinch = {
              distance: touchDistance(event.touches),
              scale: fontScale
            };
            touchScroll = null;
            return;
          }

          if (event.touches.length !== 1) {
            touchScroll = null;
            pinch = null;
            return;
          }

          const touch = event.touches[0];
          touchScroll = {
            axis: null,
            x: touch.clientX,
            y: touch.clientY,
            scrollLeft: viewport.scrollLeft,
            terminalScrollLine: term.buffer.active.viewportY
          };
        }, { passive: true, capture: true });

        viewport.addEventListener("touchmove", (event) => {
          if (event.touches.length === 2 && pinch) {
            const distance = touchDistance(event.touches);
            if (pinch.distance > 0) {
              applyFontScale(pinch.scale * (distance / pinch.distance));
            }
            if (event.cancelable) {
              event.preventDefault();
            }
            event.stopPropagation();
            return;
          }

          if (event.touches.length !== 1 || !touchScroll) {
            return;
          }

          const touch = event.touches[0];
          const deltaX = touchScroll.x - touch.clientX;
          const deltaY = touchScroll.y - touch.clientY;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);
          if (absDeltaX < 4 && absDeltaY < 4) {
            return;
          }

          if (touchScroll.axis === null) {
            touchScroll.axis = absDeltaY > absDeltaX ? "vertical" : "horizontal";
          }

          if (touchScroll.axis === "vertical") {
            const { height } = cellDimensions();
            const targetLine = Math.round(clamp(
              touchScroll.terminalScrollLine + deltaY / height,
              0,
              term.buffer.active.baseY
            ));
            term.scrollToLine(targetLine);
          } else {
            viewport.scrollLeft = touchScroll.scrollLeft + deltaX;
          }

          if (event.cancelable) {
            event.preventDefault();
          }
          event.stopPropagation();
        }, { passive: false, capture: true });

        viewport.addEventListener("touchend", (event) => {
          if (event.touches.length < 2) {
            pinch = null;
          }
          if (event.touches.length === 0) {
            touchScroll = null;
          }
        }, { passive: true, capture: true });

        viewport.addEventListener("touchcancel", () => {
          touchScroll = null;
          pinch = null;
        }, { passive: true, capture: true });
      }

      function isNearBottom() {
        const buffer = term.buffer && term.buffer.active;
        if (!buffer) {
          return true;
        }
        const distanceInRows = Math.max(0, buffer.baseY - buffer.viewportY);
        return distanceInRows * cellDimensions().height <= 24;
      }

      applyBottomInset();

      requestAnimationFrame(() => {
        fitTerminal();
        requestAnimationFrame(() => {
          fitTerminal();
          scrollToBottomImmediately();
        });
      });

      window.addEventListener("resize", () => {
        const shouldStick = stickyToBottom || isNearBottom();
        fitTerminal();
        stickyToBottom = shouldStick;
        if (shouldStick) {
          scrollToBottomImmediately();
        }
        scheduleViewportAlignment();
      });

      function finalizeRender(shouldStick) {
        stickyToBottom = shouldStick;

        if (shouldStick) {
          scrollToBottomImmediately();
        }
        scheduleViewportAlignment();

        ${enableE2EInspection ? "notifyTerminalInspection();" : ""}
      }

      function notifyReady() {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "terminal-ready" }));
      }

      ${enableE2EInspection ? `function renderedTerminalText() {
        try {
          const buffer = term.buffer.active;
          const firstLine = Math.max(0, buffer.length - 200);
          const lines = [];
          for (let index = firstLine; index < buffer.length; index += 1) {
            const line = buffer.getLine(index);
            if (line) {
              lines.push(line.translateToString(true));
            }
          }
          return lines.join("\\n");
        } catch (_error) {
          return root.dataset.kannaTextSample || "";
        }
      }

      function notifyTerminalInspection() {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "terminal-inspection",
          inspection: {
            byteCount: Number.parseInt(root.dataset.kannaByteCount || "0", 10) || 0,
            cols: Number.parseInt(root.dataset.kannaCols || "", 10) || null,
            frameCount: Number.parseInt(root.dataset.kannaFrameCount || "0", 10) || 0,
            rows: Number.parseInt(root.dataset.kannaRows || "", 10) || null,
            text: renderedTerminalText()
          }
        }));
      }` : ""}

      function notifyTerminalTap() {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
          return;
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "terminal-tap" }));
      }

      viewport.addEventListener("pointerdown", notifyTerminalTap, { passive: true });
      installPinchZoomFallback();

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

      ${enableE2EInspection ? `function resetTerminalFrameDiagnostics() {
        root.dataset.kannaFrameCount = "0";
        root.dataset.kannaByteCount = "0";
        root.dataset.kannaTextSample = "";
      }

      function recordTerminalFrame(bytes) {
        const frameCount = Number.parseInt(root.dataset.kannaFrameCount || "0", 10) || 0;
        const byteCount = Number.parseInt(root.dataset.kannaByteCount || "0", 10) || 0;
        root.dataset.kannaFrameCount = String(frameCount + 1);
        root.dataset.kannaByteCount = String(byteCount + bytes.length);
        try {
          const sample = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512));
          if (sample.trim()) {
            root.dataset.kannaTextSample = sample;
          }
        } catch (_error) {
          // TextDecoder may not be available in older WebViews; byte count still
          // proves a valid base64 frame reached the terminal write path.
        }
      }` : ""}

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
          ${enableE2EInspection ? "recordTerminalFrame(bytes);" : ""}
          term.write(bytes, writeNext);
        }

        writeNext();
      }

      window.__replaceTerminalState = function replaceTerminalState(state) {
        const shouldStick = stickyToBottom || isNearBottom();
        term.reset();
        ${enableE2EInspection ? "resetTerminalFrameDiagnostics();" : ""}
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

export function buildTerminalBottomInsetScript(bottomInset: number): string {
  return `window.__setTerminalBottomInset(${JSON.stringify({ bottomInset })}); true;`;
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
