import React, { useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  WebView as NativeWebView,
  type WebViewMessageEvent,
  type WebViewProps
} from "react-native-webview";
import type {
  TaskTerminalOutputSnapshot,
  TaskTerminalOutputSource,
  TaskTerminalStatus
} from "../state/sessionStore";
import type { TaskTerminalInputKind } from "../lib/api/client";
import {
  createTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputLength,
  type TerminalOutputBuffer,
  type TerminalOutputLike
} from "../state/terminalOutputBuffer";
import {
  captureMobileCrashDiagnostic
} from "../lib/diagnostics/mobileCrashDiagnostics";
import {
  buildTerminalAppendScript,
  buildTerminalBottomInsetScript,
  buildTerminalDirectInputScript,
  buildTerminalDocument,
  buildTerminalPrependScript,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";
import { planTerminalMutation } from "./terminalMutation";
import {
  DEFAULT_TERMINAL_BOTTOM_INSET,
  getTerminalSelectionToolbarTop
} from "./terminalSafeArea";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  parseTerminalFileMentionHistory,
  parseTerminalFileMentionRaw,
  type TerminalFileMentionHistory
} from "./terminalFileMentions";

interface TerminalWebViewProps {
  taskId: string;
  output: TerminalOutputLike;
  outputEpoch: number;
  outputStart: number;
  status: TaskTerminalStatus;
  terminalOutputSource?: TaskTerminalOutputSource;
  cols: number | null;
  rows: number | null;
  fullscreen?: boolean;
  bottomInset?: number;
  directInputEnabled?: boolean;
  directInputFocusRequest?: number;
  selectionToolbarTop?: number;
  onConsolePress?: () => void;
  onMentionedFilesChange?: (history: TerminalFileMentionHistory) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onTerminalInput?: (dataB64: string, kind: TaskTerminalInputKind) => void;
  /** The reader scrolled near the top of the loaded buffer. Whether there is
   * older scrollback to fetch is the app's question, not the page's. */
  onRequestScrollback?: () => void;
}

const ENABLE_E2E_TERMINAL_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";
const MAX_TERMINAL_SELECTION_LENGTH = 2_300_000;
const MAX_TERMINAL_INPUT_LENGTH = 8_192;

function clearTerminalSelectionScript(): string {
  return "window.__clearTerminalSelection(); true;";
}

interface TerminalWebViewHandle {
  injectJavaScript(script: string): void;
}

type PendingScriptKind = "resize" | "bottom-inset" | "direct-input";

interface PendingTerminalState {
  contentRevision: number;
  output: TerminalOutputLike;
  status: TaskTerminalStatus;
}

interface TerminalInspection {
  byteCount: number;
  cols: number | null;
  frameCount: number;
  mentionedFiles?: TerminalFileMentionHistory;
  rows: number | null;
  text: string;
}

const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<TerminalWebViewHandle>
>;

export function TerminalWebViewComponent({
  taskId,
  output,
  outputEpoch,
  outputStart,
  status,
  terminalOutputSource,
  cols,
  rows,
  fullscreen = false,
  bottomInset,
  directInputEnabled = false,
  directInputFocusRequest = 0,
  selectionToolbarTop,
  onConsolePress,
  onMentionedFilesChange,
  onOpenFile,
  onTerminalInput,
  onRequestScrollback
}: TerminalWebViewProps) {
  const webViewRef = useRef<TerminalWebViewHandle>(null);
  const bridgeReadyRef = useRef(false);
  const pendingScriptsRef = useRef<string[]>([]);
  const pendingTerminalStateRef = useRef<PendingTerminalState | null>(null);
  const previousTaskIdRef = useRef<string | null>(null);
  const previousOutputRef = useRef<TerminalOutputLike>(EMPTY_TERMINAL_OUTPUT);
  const previousOutputEpochRef = useRef(0);
  const previousOutputStartRef = useRef(0);
  const previousStatusRef = useRef<TaskTerminalStatus>("idle");
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;
  const activeOutputEpochRef = useRef(outputEpoch);
  const latestOutputStartRef = useRef(outputStart);
  const normalizedOutput = useMemo<TerminalOutputBuffer>(
    () => (typeof output === "string" ? createTerminalOutput(output) : output),
    [output]
  );
  const latestTerminalStateRef = useRef<PendingTerminalState>({
    contentRevision: outputEpoch,
    output: normalizedOutput,
    status
  });
  if (!terminalOutputSource) {
    activeOutputEpochRef.current = outputEpoch;
    latestOutputStartRef.current = outputStart;
    latestTerminalStateRef.current = {
      contentRevision: outputEpoch,
      output: normalizedOutput,
      status
    };
  }
  const selectionContextRef = useRef({ copyPending: false, version: 0 });
  const [renderedOutputEpoch, setRenderedOutputEpoch] = useState<number | null>(
    null
  );
  const [terminalInspection, setTerminalInspection] =
    useState<TerminalInspection | null>(null);
  const [terminalSelection, setTerminalSelection] = useState("");
  const [selectionCopyError, setSelectionCopyError] = useState<string | null>(null);
  const [selectionCopyPending, setSelectionCopyPending] = useState(false);
  const resolvedBottomInset =
    bottomInset ?? (fullscreen ? DEFAULT_TERMINAL_BOTTOM_INSET : 24);
  // Fullscreen embeds sit under floating screen chrome the wrapper cannot see;
  // the owner passes the measured chrome clearance so the toolbar stays
  // tappable. Non-fullscreen cards have no overlay, so the toolbar hugs the top.
  const resolvedSelectionToolbarTop =
    selectionToolbarTop ??
    (fullscreen ? getTerminalSelectionToolbarTop(null) : 12);
  const document = useMemo(
    () =>
      buildTerminalDocument({
        bottomInset: fullscreen ? DEFAULT_TERMINAL_BOTTOM_INSET : 24,
        enableE2EInspection: ENABLE_E2E_TERMINAL_INSPECTION
      }),
    [fullscreen]
  );
  // The document embeds the whole xterm bundle. Hand the native view the same
  // source object across renders so a re-render never walks it as a prop diff
  // candidate, let alone reloads it.
  const source = useMemo(() => ({ html: document }), [document]);
  const bottomInsetScript = useMemo(
    () => buildTerminalBottomInsetScript(resolvedBottomInset),
    [resolvedBottomInset]
  );

  const terminalDiagnosticDetails = () => ({
    taskId,
    status: latestTerminalStateRef.current.status,
    outputChars: terminalOutputLength(latestTerminalStateRef.current.output),
    outputEpoch: latestTerminalStateRef.current.contentRevision,
    outputStart: latestOutputStartRef.current,
    cols,
    rows,
    bridgeReady: bridgeReadyRef.current,
    pendingScriptCount:
      pendingScriptsRef.current.length +
      (pendingTerminalStateRef.current ? 1 : 0),
    renderedOutputEpoch,
    contentReady:
      status === "live" && renderedOutputEpoch === activeOutputEpochRef.current
  });

  const injectOrQueueScript = (
    script: string,
    kind: PendingScriptKind
  ) => {
    if (!bridgeReadyRef.current) {
      if (kind === "resize") {
        pendingScriptsRef.current = [
          script,
          ...pendingScriptsRef.current.filter(
            (pendingScript) => !pendingScript.includes("__setTerminalDims")
          )
        ];
      } else if (kind === "bottom-inset") {
        const withoutBottomInset = pendingScriptsRef.current.filter(
          (pendingScript) => !pendingScript.includes("__setTerminalBottomInset")
        );
        const resizeScripts = withoutBottomInset.filter((pendingScript) =>
          pendingScript.includes("__setTerminalDims")
        );
        const remainingScripts = withoutBottomInset.filter(
          (pendingScript) => !pendingScript.includes("__setTerminalDims")
        );
        pendingScriptsRef.current = [
          ...resizeScripts,
          script,
          ...remainingScripts
        ];
      } else {
        pendingScriptsRef.current = [
          ...pendingScriptsRef.current.filter(
            (pendingScript) =>
              !pendingScript.includes("__setTerminalDirectInput")
          ),
          script
        ];
      }
      return;
    }

    webViewRef.current?.injectJavaScript(script);
  };

  const queueTerminalState = () => {
    // Keep the authoritative state as raw data until xterm is ready. Building
    // an injected replacement splits and serializes the full retained stream,
    // so doing that for every pre-ready frame creates discarded O(history)
    // work. The ready message consumes exactly the latest state once.
    pendingTerminalStateRef.current = latestTerminalStateRef.current;
  };

  const replaceTerminalState = (terminalState: PendingTerminalState) => {
    if (!bridgeReadyRef.current) {
      queueTerminalState();
      return;
    }
    webViewRef.current?.injectJavaScript(
      buildTerminalReplaceScript(terminalState)
    );
  };

  const prependTerminalScrollback = (terminalState: PendingTerminalState) => {
    if (!bridgeReadyRef.current) {
      queueTerminalState();
      return;
    }
    webViewRef.current?.injectJavaScript(
      buildTerminalPrependScript(terminalState)
    );
  };

  const appendTerminalChunk = (chunk: string) => {
    if (!bridgeReadyRef.current) {
      queueTerminalState();
      return;
    }
    webViewRef.current?.injectJavaScript(buildTerminalAppendScript(chunk));
  };

  const applyTerminalOutputSnapshot = (
    snapshot: TaskTerminalOutputSnapshot
  ) => {
    activeOutputEpochRef.current = snapshot.outputEpoch;
    latestOutputStartRef.current = snapshot.outputStart;
    latestTerminalStateRef.current = {
      contentRevision: snapshot.outputEpoch,
      output: snapshot.output,
      status: snapshot.status
    };
    const mutation = planTerminalMutation({
      previousEpoch: previousOutputEpochRef.current,
      previousOutput: previousOutputRef.current,
      previousStart: previousOutputStartRef.current,
      previousStatus: previousStatusRef.current,
      nextEpoch: snapshot.outputEpoch,
      nextOutput: snapshot.output,
      nextStart: snapshot.outputStart,
      nextStatus: snapshot.status,
      nextPrependedScrollback: snapshot.prependedScrollback
    });

    previousOutputRef.current = snapshot.output;
    previousOutputEpochRef.current = snapshot.outputEpoch;
    previousOutputStartRef.current = snapshot.outputStart;
    previousStatusRef.current = snapshot.status;

    switch (mutation.kind) {
      case "append":
        appendTerminalChunk(mutation.chunk);
        break;
      case "replace":
        replaceTerminalState({
          contentRevision: snapshot.outputEpoch,
          output: mutation.output,
          status: mutation.status
        });
        break;
      case "prepend":
        prependTerminalScrollback({
          contentRevision: snapshot.outputEpoch,
          output: mutation.output,
          status: mutation.status
        });
        break;
      case "none":
      default:
        break;
    }
  };
  const applyTerminalOutputSnapshotRef = useRef(applyTerminalOutputSnapshot);
  applyTerminalOutputSnapshotRef.current = applyTerminalOutputSnapshot;

  useEffect(() => {
    const taskChanged = previousTaskIdRef.current !== taskId;

    if (taskChanged) {
      selectionContextRef.current.version += 1;
      selectionContextRef.current.copyPending = false;
      onMentionedFilesChange?.({ mentions: [], overflow: false });
      setTerminalSelection("");
      setSelectionCopyError(null);
      setSelectionCopyPending(false);
      previousTaskIdRef.current = taskId;
      const sourceSnapshot = terminalOutputSource?.getSnapshot();
      const initialSnapshot =
        sourceSnapshot?.taskId === taskId
          ? sourceSnapshot
          : {
              taskId,
              output: normalizedOutput,
              outputEpoch,
              outputStart,
              status,
              prependedScrollback: false
            };
      activeOutputEpochRef.current = initialSnapshot.outputEpoch;
      latestOutputStartRef.current = initialSnapshot.outputStart;
      latestTerminalStateRef.current = {
        contentRevision: initialSnapshot.outputEpoch,
        output: initialSnapshot.output,
        status: initialSnapshot.status
      };
      previousOutputRef.current = initialSnapshot.output;
      previousOutputEpochRef.current = initialSnapshot.outputEpoch;
      previousOutputStartRef.current = initialSnapshot.outputStart;
      previousStatusRef.current = initialSnapshot.status;
      replaceTerminalState(latestTerminalStateRef.current);
      return;
    }

    // The dedicated source can advance after render but before passive effects.
    // Never let the render-time prop snapshot overwrite that newer output.
    if (terminalOutputSource) return;

    applyTerminalOutputSnapshot({
      taskId,
      output: normalizedOutput,
      outputEpoch,
      outputStart,
      status,
      prependedScrollback: false
    });
  }, [
    onMentionedFilesChange,
    normalizedOutput,
    outputEpoch,
    outputStart,
    status,
    taskId,
    terminalOutputSource
  ]);

  useEffect(() => {
    if (!terminalOutputSource) return;

    const applyCurrentOutput = () => {
      const snapshot = terminalOutputSource.getSnapshot();
      if (snapshot.taskId !== activeTaskIdRef.current) return;
      applyTerminalOutputSnapshotRef.current(snapshot);
    };
    const unsubscribe = terminalOutputSource.subscribe(applyCurrentOutput);
    // Close the subscribe-after-render race without relying on a replay timer.
    applyCurrentOutput();
    return unsubscribe;
  }, [taskId, terminalOutputSource]);

  useEffect(() => {
    if (cols && rows) {
      injectOrQueueScript(buildTerminalResizeScript(cols, rows), "resize");
    }
  }, [cols, rows]);

  useEffect(() => {
    injectOrQueueScript(bottomInsetScript, "bottom-inset");
  }, [bottomInsetScript]);

  useEffect(() => {
    injectOrQueueScript(
      buildTerminalDirectInputScript(directInputEnabled),
      "direct-input"
    );
  }, [directInputEnabled, directInputFocusRequest]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let payload: {
      type?: unknown;
      inspection?: TerminalInspection;
      mentions?: unknown;
      overflow?: unknown;
      path?: unknown;
      line?: unknown;
      text?: unknown;
      dataB64?: unknown;
      kind?: unknown;
      contentRevision?: unknown;
    };

    try {
      const parsed = JSON.parse(event.nativeEvent.data) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return;
      }
      payload = parsed;
    } catch {
      return;
    }

    if (payload.type === "terminal-file-link") {
      if (typeof payload.path !== "string") {
        return;
      }
      const path = payload.path.trim();
      const parsedPath = parseTerminalFileMentionRaw(path);
      if (!parsedPath || parsedPath.path !== path || parsedPath.line !== undefined) {
        return;
      }
      if (
        typeof payload.line === "number" &&
        Number.isInteger(payload.line) &&
        payload.line > 0
      ) {
        onOpenFile?.(path, payload.line);
      } else {
        onOpenFile?.(path);
      }
      return;
    }

    if (payload.type === "terminal-file-mentions") {
      const history = parseTerminalFileMentionHistory(payload);
      if (history) {
        onMentionedFilesChange?.(history);
      }
      return;
    }

    if (payload.type === "terminal-selection-change") {
      if (
        typeof payload.text !== "string" ||
        payload.text.length > MAX_TERMINAL_SELECTION_LENGTH
      ) {
        return;
      }
      selectionContextRef.current.version += 1;
      selectionContextRef.current.copyPending = false;
      setTerminalSelection(payload.text);
      setSelectionCopyError(null);
      setSelectionCopyPending(false);
      return;
    }

    if (payload.type === "terminal-input") {
      if (
        typeof payload.dataB64 === "string" &&
        payload.dataB64.length > 0 &&
        payload.dataB64.length <= MAX_TERMINAL_INPUT_LENGTH &&
        (payload.kind === "draft" ||
          payload.kind === "submission" ||
          payload.kind === "control")
      ) {
        onTerminalInput?.(payload.dataB64, payload.kind);
      }
      return;
    }

    if (payload.type === "terminal-scrollback-request") {
      onRequestScrollback?.();
      return;
    }

    if (payload.type === "terminal-tap") {
      onConsolePress?.();
      return;
    }

    if (
      ENABLE_E2E_TERMINAL_INSPECTION &&
      payload.type === "terminal-inspection" &&
      payload.inspection
    ) {
      setTerminalInspection(payload.inspection);
      return;
    }

    if (payload.type === "terminal-content-ready") {
      if (
        typeof payload.contentRevision === "number" &&
        Number.isSafeInteger(payload.contentRevision) &&
        payload.contentRevision === activeOutputEpochRef.current
      ) {
        setRenderedOutputEpoch(payload.contentRevision);
      }
      return;
    }

    if (payload.type !== "terminal-ready") {
      return;
    }

    bridgeReadyRef.current = true;
    const pending =
      pendingScriptsRef.current.length > 0
        ? pendingScriptsRef.current
        : [
            ...(cols && rows ? [buildTerminalResizeScript(cols, rows)] : []),
            bottomInsetScript,
            buildTerminalDirectInputScript(directInputEnabled)
          ];
    pendingScriptsRef.current = [];
    for (const script of pending) {
      webViewRef.current?.injectJavaScript(script);
    }
    const terminalState =
      pendingTerminalStateRef.current ?? latestTerminalStateRef.current;
    pendingTerminalStateRef.current = null;
    webViewRef.current?.injectJavaScript(
      buildTerminalReplaceScript(terminalState)
    );
  };

  const isTerminalContentReady =
    status === "live" && renderedOutputEpoch === outputEpoch;

  const clearTerminalSelection = () => {
    selectionContextRef.current.version += 1;
    selectionContextRef.current.copyPending = false;
    setTerminalSelection("");
    setSelectionCopyError(null);
    setSelectionCopyPending(false);
    webViewRef.current?.injectJavaScript(clearTerminalSelectionScript());
  };

  const copyTerminalSelection = async () => {
    if (!terminalSelection || selectionContextRef.current.copyPending) return;
    const selectionContextVersion = selectionContextRef.current.version;
    selectionContextRef.current.copyPending = true;
    setSelectionCopyPending(true);
    try {
      await Clipboard.setStringAsync(terminalSelection);
      if (
        activeTaskIdRef.current !== taskId ||
        selectionContextRef.current.version !== selectionContextVersion
      ) {
        return;
      }
      clearTerminalSelection();
    } catch {
      if (
        activeTaskIdRef.current !== taskId ||
        selectionContextRef.current.version !== selectionContextVersion
      ) {
        return;
      }
      selectionContextRef.current.copyPending = false;
      setSelectionCopyPending(false);
      setSelectionCopyError("Couldn’t copy. Try again.");
    }
  };

  return (
    <View style={fullscreen ? styles.wrapFullscreen : styles.wrap}>
      {!isTerminalContentReady ? (
        <View
          accessibilityLabel="Loading terminal content"
          accessibilityLiveRegion="polite"
          accessibilityRole="progressbar"
          accessibilityState={{ busy: true }}
          pointerEvents="none"
          style={[styles.contentLoading, { top: resolvedSelectionToolbarTop }]}
          testID={MOBILE_E2E_IDS.terminalOverlay}
        >
          <ActivityIndicator accessible={false} color="#A9D7FF" size="small" />
          <Text accessible={false} style={styles.contentLoadingText}>
            Loading terminal content
          </Text>
        </View>
      ) : null}
      {ENABLE_E2E_TERMINAL_INSPECTION && terminalInspection ? (
        <Text
          accessibilityValue={{ text: JSON.stringify(terminalInspection) }}
          pointerEvents="none"
          style={styles.e2eTerminalInspection}
          testID={MOBILE_E2E_IDS.terminalInspection}
        >
          {JSON.stringify(terminalInspection)}
        </Text>
      ) : null}
      {terminalSelection ? (
        <View
          accessibilityLabel="Terminal text selection controls"
          style={[styles.selectionToolbar, { top: resolvedSelectionToolbarTop }]}
        >
          <Text accessibilityLiveRegion="polite" style={styles.selectionStatus}>
            {selectionCopyError ?? "Text selected"}
          </Text>
          <Pressable
            accessibilityLabel="Copy selected terminal text"
            accessibilityRole="button"
            disabled={selectionCopyPending}
            onPress={copyTerminalSelection}
            style={styles.selectionButtonPrimary}
          >
            <Text style={styles.selectionButtonPrimaryText}>Copy</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Cancel terminal text selection"
            accessibilityRole="button"
            onPress={clearTerminalSelection}
            style={styles.selectionButton}
          >
            <Text style={styles.selectionButtonText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        onLoadStart={() => {
          bridgeReadyRef.current = false;
          setRenderedOutputEpoch(null);
          selectionContextRef.current.version += 1;
          selectionContextRef.current.copyPending = false;
          setTerminalSelection("");
          setSelectionCopyError(null);
          setSelectionCopyPending(false);
          pendingScriptsRef.current = [
            ...(cols && rows ? [buildTerminalResizeScript(cols, rows)] : []),
            bottomInsetScript,
            buildTerminalDirectInputScript(directInputEnabled)
          ];
          pendingTerminalStateRef.current = latestTerminalStateRef.current;
        }}
        onError={(event) => {
          captureMobileCrashDiagnostic({
            kind: "webview-load-error",
            message: event.nativeEvent.description,
            details: {
              ...terminalDiagnosticDetails(),
              code: event.nativeEvent.code,
              domain: event.nativeEvent.domain,
              url: event.nativeEvent.url
            }
          });
        }}
        onContentProcessDidTerminate={(event) => {
          captureMobileCrashDiagnostic({
            kind: "webview-process-terminated",
            message: "The iOS terminal WebView content process terminated.",
            details: {
              ...terminalDiagnosticDetails(),
              platform: "ios",
              url: event.nativeEvent.url
            }
          });
        }}
        onRenderProcessGone={(event) => {
          captureMobileCrashDiagnostic({
            kind: "webview-process-terminated",
            message: event.nativeEvent.didCrash
              ? "The Android terminal WebView render process crashed."
              : "The Android terminal WebView render process was terminated.",
            details: {
              ...terminalDiagnosticDetails(),
              didCrash: event.nativeEvent.didCrash,
              platform: "android"
            }
          });
        }}
        onMessage={handleMessage}
        keyboardDisplayRequiresUserAction={false}
        scrollEnabled
        source={source}
        style={fullscreen ? styles.webviewFullscreen : styles.webview}
        webviewDebuggingEnabled={ENABLE_E2E_TERMINAL_INSPECTION}
      />
    </View>
  );
}

// The task screen owns the terminal and the reply composer, so it re-renders on
// state the terminal has no stake in — every keystroke of a draft, every
// keyboard frame, every chrome measurement. The terminal drives a live xterm
// document through refs and effects, so those renders are not free: they re-run
// the output-sync effect and can re-drive the terminal from render-time props
// that trail the dedicated output source. Re-render only when the terminal's
// own inputs change.
export const TerminalWebView = React.memo(TerminalWebViewComponent);

const styles = StyleSheet.create({
  contentLoading: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#10213AEE",
    borderColor: "#365B83",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: "absolute",
    zIndex: 9
  },
  contentLoadingText: {
    color: "#D8E7F7",
    fontSize: 12,
    fontWeight: "600"
  },
  selectionButton: {
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  selectionButtonPrimary: {
    backgroundColor: "#A9D7FF",
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  selectionButtonPrimaryText: {
    color: "#07101D",
    fontSize: 12,
    fontWeight: "700"
  },
  selectionButtonText: {
    color: "#A9D7FF",
    fontSize: 12,
    fontWeight: "700"
  },
  selectionStatus: {
    color: "#D8E7F7",
    fontSize: 12
  },
  selectionToolbar: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#10213A",
    borderColor: "#365B83",
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 8,
    position: "absolute",
    zIndex: 10
  },
  wrap: {
    backgroundColor: "#050B14",
    borderColor: "#15243C",
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 260,
    overflow: "hidden"
  },
  wrapFullscreen: {
    backgroundColor: "#050B14",
    flex: 1,
    overflow: "hidden"
  },
  webview: {
    backgroundColor: "#050B14",
    minHeight: 260
  },
  webviewFullscreen: {
    backgroundColor: "#050B14",
    flex: 1
  },
  e2eTerminalInspection: {
    color: "transparent",
    fontSize: 1,
    height: 1,
    left: 0,
    opacity: 0.01,
    position: "absolute",
    top: 0,
    width: 1
  }
});
