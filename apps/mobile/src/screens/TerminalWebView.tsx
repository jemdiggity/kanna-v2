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
  buildTerminalDocument,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";
import { planTerminalMutation } from "./terminalMutation";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

interface TerminalWebViewProps {
  taskId: string;
  output: string;
  status: TaskTerminalStatus;
  cols: number | null;
  rows: number | null;
  fullscreen?: boolean;
  onConsolePress?: () => void;
}

const FULLSCREEN_BOTTOM_INSET = 132;
const ENABLE_E2E_TERMINAL_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";

interface TerminalWebViewHandle {
  injectJavaScript(script: string): void;
}

type PendingScriptKind = "terminal-state" | "resize";

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
  onConsolePress
}: TerminalWebViewProps) {
  const webViewRef = useRef<TerminalWebViewHandle>(null);
  const bridgeReadyRef = useRef(false);
  const pendingScriptsRef = useRef<string[]>([]);
  const previousTaskIdRef = useRef<string | null>(null);
  const previousOutputRef = useRef("");
  const previousStatusRef = useRef<TaskTerminalStatus>("idle");
  const [terminalInspection, setTerminalInspection] = useState<TerminalInspection | null>(null);
  const document = useMemo(
    () =>
      buildTerminalDocument({
        bottomInset: fullscreen ? FULLSCREEN_BOTTOM_INSET : 24,
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

  const handleMessage = (event: WebViewMessageEvent) => {
    let payload: { type?: string; inspection?: TerminalInspection } | null = null;

    try {
      payload = JSON.parse(event.nativeEvent.data) as {
        type?: string;
        inspection?: TerminalInspection;
      };
    } catch {
      return;
    }

    if (payload?.type === "terminal-tap") {
      onConsolePress?.();
      return;
    }

    if (
      ENABLE_E2E_TERMINAL_INSPECTION &&
      payload?.type === "terminal-inspection" &&
      payload.inspection
    ) {
      setTerminalInspection(payload.inspection);
      return;
    }

    if (payload?.type !== "terminal-ready") {
      return;
    }

    bridgeReadyRef.current = true;
    const pending =
      pendingScriptsRef.current.length > 0
        ? pendingScriptsRef.current
        : [replaceScript];
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
          pendingScriptsRef.current =
            cols && rows
              ? [buildTerminalResizeScript(cols, rows), replaceScript]
              : [replaceScript];
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
