import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
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

const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<TerminalWebViewHandle>
>;

export function TerminalWebView({
  taskId,
  output,
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
  const previousStatusRef = useRef<TaskTerminalStatus>("idle");
  const [terminalInspection, setTerminalInspection] = useState<TerminalInspection | null>(null);
  const resolvedBottomInset =
    bottomInset ?? (fullscreen ? DEFAULT_TERMINAL_BOTTOM_INSET : 24);
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
      previousTaskIdRef.current = taskId;
      previousOutputRef.current = output;
      previousStatusRef.current = status;
      injectOrQueueScript(replaceScript);
      return;
    }

    const mutation = planTerminalMutation({
      previousOutput: previousOutputRef.current,
      previousStatus: previousStatusRef.current,
      nextOutput: output,
      nextStatus: status
    });

    previousOutputRef.current = output;
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
  }, [output, replaceScript, status, taskId]);

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
      path?: unknown;
      line?: unknown;
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
      if (!path) {
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
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        onLoadStart={() => {
          bridgeReadyRef.current = false;
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
