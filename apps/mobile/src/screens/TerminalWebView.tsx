import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import {
  WebView as NativeWebView,
  type WebViewMessageEvent,
  type WebViewProps
} from "react-native-webview";
import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalReplaceScript
} from "./buildTerminalDocument";
import { planTerminalMutation } from "./terminalMutation";

interface TerminalWebViewProps {
  taskId: string;
  output: string;
  status: TaskTerminalStatus;
  fullscreen?: boolean;
  onConsolePress?: () => void;
}

const FULLSCREEN_BOTTOM_INSET = 132;

interface TerminalWebViewHandle {
  injectJavaScript(script: string): void;
}

const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<TerminalWebViewHandle>
>;

export function TerminalWebView({
  taskId,
  output,
  status,
  fullscreen = false,
  onConsolePress
}: TerminalWebViewProps) {
  const webViewRef = useRef<TerminalWebViewHandle>(null);
  const bridgeReadyRef = useRef(false);
  const pendingScriptRef = useRef<string | null>(null);
  const previousTaskIdRef = useRef<string | null>(null);
  const previousOutputRef = useRef("");
  const previousStatusRef = useRef<TaskTerminalStatus>("idle");
  const document = useMemo(
    () =>
      buildTerminalDocument({
        bottomInset: fullscreen ? FULLSCREEN_BOTTOM_INSET : 24
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

  const injectOrQueueScript = (script: string) => {
    pendingScriptRef.current = script;

    if (!bridgeReadyRef.current) {
      return;
    }

    webViewRef.current?.injectJavaScript(script);
    pendingScriptRef.current = null;
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

  const handleMessage = (event: WebViewMessageEvent) => {
    let payload: { type?: string } | null = null;

    try {
      payload = JSON.parse(event.nativeEvent.data) as { type?: string };
    } catch {
      return;
    }

    if (payload?.type === "terminal-tap") {
      onConsolePress?.();
      return;
    }

    if (payload?.type !== "terminal-ready") {
      return;
    }

    bridgeReadyRef.current = true;
    const pendingScript = pendingScriptRef.current ?? replaceScript;
    webViewRef.current?.injectJavaScript(pendingScript);
    pendingScriptRef.current = null;
  };

  return (
    <View style={fullscreen ? styles.wrapFullscreen : styles.wrap}>
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        onLoadStart={() => {
          bridgeReadyRef.current = false;
          pendingScriptRef.current = replaceScript;
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
  }
});
