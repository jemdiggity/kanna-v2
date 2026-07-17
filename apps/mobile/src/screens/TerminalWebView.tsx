import React, { useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  WebView as NativeWebView,
  type WebViewMessageEvent,
  type WebViewProps
} from "react-native-webview";
import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  buildTerminalAppendScript,
  buildTerminalBottomInsetScript,
  buildTerminalDocument,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";
import { planTerminalMutation } from "./terminalMutation";
import { DEFAULT_TERMINAL_BOTTOM_INSET } from "./terminalSafeArea";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

interface TerminalWebViewProps {
  taskId: string;
  output: string;
  outputEpoch: number;
  outputStart: number;
  status: TaskTerminalStatus;
  cols: number | null;
  rows: number | null;
  fullscreen?: boolean;
  bottomInset?: number;
  onConsolePress?: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}

const ENABLE_E2E_TERMINAL_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";
const MAX_TERMINAL_SELECTION_LENGTH = 2_300_000;

function clearTerminalSelectionScript(): string {
  return "window.__clearTerminalSelection(); true;";
}

interface TerminalWebViewHandle {
  injectJavaScript(script: string): void;
}

type PendingScriptKind = "terminal-state" | "resize" | "bottom-inset";

interface TerminalInspection {
  byteCount: number;
  cols: number | null;
  frameCount: number;
  rows: number | null;
  text: string;
}

interface TerminalFileLink {
  line?: number;
  path: string;
  raw: string;
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function parseTerminalFileLinkRaw(raw: string): { line?: number; path: string } | null {
  const parts = raw.split(":");
  const suffixes: number[] = [];
  while (parts.length > 1 && suffixes.length < 2) {
    const maybeNumber = parts[parts.length - 1];
    if (!maybeNumber || !/^\d+$/.test(maybeNumber)) break;
    suffixes.unshift(Number.parseInt(maybeNumber, 10));
    parts.pop();
  }

  const path = parts.join(":");
  if (!isMarkdownPath(path)) return null;
  return {
    path,
    ...(suffixes[0] === undefined ? {} : { line: suffixes[0] })
  };
}

const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<TerminalWebViewHandle>
>;

export function TerminalWebView({
  taskId,
  output,
  outputEpoch,
  outputStart,
  status,
  cols,
  rows,
  fullscreen = false,
  bottomInset,
  onConsolePress,
  onOpenFile
}: TerminalWebViewProps) {
  const webViewRef = useRef<TerminalWebViewHandle>(null);
  const bridgeReadyRef = useRef(false);
  const pendingScriptsRef = useRef<string[]>([]);
  const previousTaskIdRef = useRef<string | null>(null);
  const previousOutputRef = useRef("");
  const previousOutputEpochRef = useRef(0);
  const previousOutputStartRef = useRef(0);
  const previousStatusRef = useRef<TaskTerminalStatus>("idle");
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;
  const selectionContextRef = useRef({ copyPending: false, version: 0 });
  const [terminalInspection, setTerminalInspection] = useState<TerminalInspection | null>(null);
  const [terminalSelection, setTerminalSelection] = useState("");
  const [selectionCopyError, setSelectionCopyError] = useState<string | null>(null);
  const [selectionCopyPending, setSelectionCopyPending] = useState(false);
  const resolvedBottomInset =
    bottomInset ?? (fullscreen ? DEFAULT_TERMINAL_BOTTOM_INSET : 24);
  const [terminalFileLinks, setTerminalFileLinks] = useState<TerminalFileLink[]>([]);
  const document = useMemo(
    () =>
      buildTerminalDocument({
        bottomInset: fullscreen ? DEFAULT_TERMINAL_BOTTOM_INSET : 24,
        enableE2EInspection: ENABLE_E2E_TERMINAL_INSPECTION
      }),
    [fullscreen]
  );
  const replaceScript = useMemo(
    () =>
      buildTerminalReplaceScript({
        output,
        status
      }),
    [output, status]
  );
  const bottomInsetScript = useMemo(
    () => buildTerminalBottomInsetScript(resolvedBottomInset),
    [resolvedBottomInset]
  );

  const injectOrQueueScript = (
    script: string,
    kind: PendingScriptKind = "terminal-state"
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
        pendingScriptsRef.current.push(script);
      }
      return;
    }

    webViewRef.current?.injectJavaScript(script);
  };

  useEffect(() => {
    const taskChanged = previousTaskIdRef.current !== taskId;

    if (taskChanged) {
      selectionContextRef.current.version += 1;
      selectionContextRef.current.copyPending = false;
      setTerminalFileLinks([]);
      setTerminalSelection("");
      setSelectionCopyError(null);
      setSelectionCopyPending(false);
      previousTaskIdRef.current = taskId;
      previousOutputRef.current = output;
      previousOutputEpochRef.current = outputEpoch;
      previousOutputStartRef.current = outputStart;
      previousStatusRef.current = status;
      injectOrQueueScript(replaceScript);
      return;
    }

    const mutation = planTerminalMutation({
      previousEpoch: previousOutputEpochRef.current,
      previousOutput: previousOutputRef.current,
      previousStart: previousOutputStartRef.current,
      previousStatus: previousStatusRef.current,
      nextEpoch: outputEpoch,
      nextOutput: output,
      nextStart: outputStart,
      nextStatus: status
    });

    previousOutputRef.current = output;
    previousOutputEpochRef.current = outputEpoch;
    previousOutputStartRef.current = outputStart;
    previousStatusRef.current = status;

    switch (mutation.kind) {
      case "append":
        injectOrQueueScript(buildTerminalAppendScript(mutation.chunk));
        break;
      case "replace":
        injectOrQueueScript(
          buildTerminalReplaceScript({
            output: mutation.output,
            status: mutation.status
          })
        );
        break;
      case "none":
      default:
        break;
    }
  }, [output, outputEpoch, outputStart, replaceScript, status, taskId]);

  useEffect(() => {
    if (cols && rows) {
      injectOrQueueScript(buildTerminalResizeScript(cols, rows), "resize");
    }
  }, [cols, rows]);

  useEffect(() => {
    injectOrQueueScript(bottomInsetScript, "bottom-inset");
  }, [bottomInsetScript]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let payload: {
      type?: unknown;
      inspection?: TerminalInspection;
      links?: unknown;
      path?: unknown;
      line?: unknown;
      text?: unknown;
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
      if (!path || !isMarkdownPath(path)) {
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

    if (payload.type === "terminal-file-links" && Array.isArray(payload.links)) {
      const links: TerminalFileLink[] = [];
      for (const candidate of payload.links) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          continue;
        }
        const record = candidate as Record<string, unknown>;
        const path = typeof record.path === "string" ? record.path.trim() : "";
        const raw = typeof record.raw === "string" ? record.raw.trim() : "";
        if (!path || !raw || !isMarkdownPath(path)) continue;
        const candidateLine = record.line;
        const line =
          typeof candidateLine === "number" &&
          Number.isInteger(candidateLine) &&
          candidateLine > 0
            ? candidateLine
            : undefined;
        const parsedRaw = parseTerminalFileLinkRaw(raw);
        if (
          !parsedRaw ||
          parsedRaw.path !== path ||
          parsedRaw.line !== line
        ) {
          continue;
        }
        links.push({
          path,
          raw,
          ...(line === undefined ? {} : { line })
        });
      }
      setTerminalFileLinks(links.slice(-6));
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
            replaceScript
          ];
    pendingScriptsRef.current = [];
    for (const script of pending) {
      webViewRef.current?.injectJavaScript(script);
    }
  };

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
      {terminalFileLinks.length ? (
        <ScrollView
          accessible={false}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={styles.fileLinks}
        >
          <Text
            accessibilityLabel="Files mentioned in terminal"
            accessibilityRole="header"
            style={styles.fileLinksLabel}
          >
            Files
          </Text>
          {terminalFileLinks.map((link) => (
            <Pressable
              accessibilityLabel={
                link.line === undefined
                  ? `Open file ${link.path}`
                  : `Open file ${link.path} at line ${link.line}`
              }
              accessibilityRole="button"
              key={link.raw}
              onPress={() => onOpenFile?.(link.path, link.line)}
              style={styles.fileLink}
            >
              <Text ellipsizeMode="middle" numberOfLines={1} style={styles.fileLinkText}>
                {link.raw}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {terminalSelection ? (
        <View
          accessibilityLabel="Terminal text selection controls"
          style={[
            styles.selectionToolbar,
            { top: terminalFileLinks.length ? 55 : 12 }
          ]}
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
          selectionContextRef.current.version += 1;
          selectionContextRef.current.copyPending = false;
          setTerminalSelection("");
          setSelectionCopyError(null);
          setSelectionCopyPending(false);
          pendingScriptsRef.current = [
            ...(cols && rows ? [buildTerminalResizeScript(cols, rows)] : []),
            bottomInsetScript,
            replaceScript
          ];
        }}
        onMessage={handleMessage}
        onLoadEnd={() => {
          previousTaskIdRef.current = taskId;
          previousOutputRef.current = output;
          previousOutputEpochRef.current = outputEpoch;
          previousOutputStartRef.current = outputStart;
          previousStatusRef.current = status;
        }}
        scrollEnabled
        source={{ html: document }}
        style={fullscreen ? styles.webviewFullscreen : styles.webview}
        webviewDebuggingEnabled={ENABLE_E2E_TERMINAL_INSPECTION}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fileLink: {
    alignItems: "center",
    backgroundColor: "#10213A",
    borderColor: "#365B83",
    borderRadius: 7,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    marginRight: 7,
    maxWidth: 96,
    paddingHorizontal: 10
  },
  fileLinks: {
    backgroundColor: "#07101D",
    borderBottomColor: "#1D2C43",
    borderBottomWidth: 1,
    flexGrow: 0,
    maxHeight: 43,
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  fileLinksLabel: {
    color: "#8292A9",
    fontSize: 10,
    fontWeight: "700",
    lineHeight: 32,
    marginRight: 8,
    textTransform: "uppercase"
  },
  fileLinkText: {
    color: "#A9D7FF",
    fontFamily: "Menlo",
    fontSize: 11,
    textDecorationLine: "underline"
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
