import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  WebView as NativeWebView,
  type WebViewNavigation,
  type WebViewProps
} from "react-native-webview";
import type { TaskPort, TaskPreviewOpenResult } from "../lib/api/types";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

interface WebViewHandle {
  reload(): void;
}

interface PreviewNavigation extends WebViewNavigation {
  isTopFrame: boolean;
}

const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<WebViewHandle>
>;
const ENABLE_E2E_WEBVIEW_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";

export interface TaskPreviewModalProps {
  taskTitle: string;
  ports: readonly TaskPort[];
  onOpen(portName?: string): Promise<TaskPreviewOpenResult>;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function TaskPreviewModal({
  taskTitle,
  ports,
  onOpen,
  onClose
}: TaskPreviewModalProps) {
  const [selectedPortName, setSelectedPortName] = useState(
    ports[0]?.name ?? ""
  );
  const [opened, setOpened] = useState<TaskPreviewOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const webViewRef = useRef<WebViewHandle>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let current = true;
    setOpened(null);
    setError(null);
    void onOpenRef.current(selectedPortName || undefined)
      .then((result) => {
        if (current) setOpened(result);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorMessage(reason));
      });
    return () => {
      current = false;
    };
  }, [retry, selectedPortName]);

  const origin = useMemo(() => {
    if (!opened) return null;
    try {
      return new URL(opened.url).origin;
    } catch {
      return null;
    }
  }, [opened]);
  const selectedPort =
    ports.find((port) => port.name === selectedPortName) ?? ports[0];

  const close = () => onClose();

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="fullScreen"
      visible
    >
      <SafeAreaView
        style={styles.safeArea}
        testID={MOBILE_E2E_IDS.taskPreviewModal}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.title}>
              {taskTitle}
            </Text>
            <Text style={styles.subtitle}>
              {selectedPort
                ? `${selectedPort.name} · ${selectedPort.port}`
                : "Dev-server preview"}
            </Text>
          </View>
          {opened ? (
            <Pressable
              accessibilityLabel="Refresh preview"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => webViewRef.current?.reload()}
              style={styles.headerButton}
              testID={MOBILE_E2E_IDS.taskPreviewRefresh}
            >
              <Text style={styles.headerButtonText}>Refresh</Text>
            </Pressable>
          ) : null}
          {opened ? (
            <Pressable
              accessibilityLabel="Open preview in browser"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                void onOpenRef
                  .current(selectedPortName || undefined)
                  .then((browserPreview) => Linking.openURL(browserPreview.url))
                  .catch((reason: unknown) =>
                    setError(
                      `Could not open the browser: ${errorMessage(reason)}`
                    )
                  );
              }}
              style={styles.headerButton}
              testID={MOBILE_E2E_IDS.taskPreviewBrowser}
            >
              <Text style={styles.headerButtonText}>Browser</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={close}
            style={styles.headerButton}
            testID={MOBILE_E2E_IDS.taskPreviewClose}
          >
            <Text style={styles.headerButtonText}>Close</Text>
          </Pressable>
        </View>

        {ports.length > 1 ? (
          <ScrollView
            contentContainerStyle={styles.portList}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {ports.map((port) => {
              const selected = port.name === selectedPortName;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={port.name}
                  onPress={() => setSelectedPortName(port.name)}
                  style={[
                    styles.portButton,
                    selected ? styles.portButtonSelected : null
                  ]}
                  testID={MOBILE_E2E_IDS.taskPreviewPort(port.name)}
                >
                  <Text
                    style={[
                      styles.portButtonText,
                      selected ? styles.portButtonTextSelected : null
                    ]}
                  >
                    {port.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {error ? (
          <View style={styles.message}>
            <Text
              accessibilityLiveRegion="polite"
              style={styles.messageText}
              testID={MOBILE_E2E_IDS.taskPreviewError}
            >
              {error}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setRetry((value) => value + 1)}
              style={styles.retryButton}
              testID={MOBILE_E2E_IDS.taskPreviewRetry}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : opened && origin ? (
          <WebView
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            allowsLinkPreview={false}
            cacheEnabled
            domStorageEnabled
            javaScriptCanOpenWindowsAutomatically={false}
            javaScriptEnabled
            mixedContentMode="never"
            onError={(event) => setError(event.nativeEvent.description)}
            onShouldStartLoadWithRequest={(
              request: PreviewNavigation
            ) => {
              if (
                request.url === "about:blank" ||
                sameOrigin(request.url, origin)
              ) {
                return true;
              }
              if (request.isTopFrame && request.navigationType === "click") {
                void Linking.openURL(request.url).catch((reason: unknown) =>
                  setError(
                    `Could not open the browser: ${errorMessage(reason)}`
                  )
                );
              }
              return false;
            }}
            originWhitelist={[origin]}
            ref={webViewRef}
            setSupportMultipleWindows={false}
            sharedCookiesEnabled={false}
            source={{ uri: opened.url }}
            style={styles.webView}
            testID={MOBILE_E2E_IDS.taskPreviewWebView}
            thirdPartyCookiesEnabled={false}
            webviewDebuggingEnabled={ENABLE_E2E_WEBVIEW_INSPECTION}
          />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color="#9CC5FF" size="large" />
            <Text style={styles.loadingText}>Opening preview…</Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: "#050B14", flex: 1 },
  header: {
    alignItems: "center",
    borderBottomColor: "#1D2C43",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: "#F4F8FF", fontSize: 16, fontWeight: "700" },
  subtitle: { color: "#8292A9", fontSize: 11, marginTop: 2 },
  headerButton: {
    borderColor: "#31415B",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  headerButtonText: { color: "#D7E2F0", fontSize: 13, fontWeight: "600" },
  portList: { gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  portButton: {
    borderColor: "#31415B",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  portButtonSelected: { backgroundColor: "#183358", borderColor: "#579BEE" },
  portButtonText: { color: "#9DABC0", fontSize: 12 },
  portButtonTextSelected: { color: "#E8F1FF", fontWeight: "700" },
  webView: { backgroundColor: "#FFFFFF", flex: 1 },
  loading: { alignItems: "center", flex: 1, gap: 14, justifyContent: "center" },
  loadingText: { color: "#AEBBD0", fontSize: 14 },
  message: {
    alignItems: "center",
    flex: 1,
    gap: 18,
    justifyContent: "center",
    paddingHorizontal: 28
  },
  messageText: {
    color: "#D7E2F0",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center"
  },
  retryButton: {
    backgroundColor: "#285C96",
    borderRadius: 9,
    paddingHorizontal: 18,
    paddingVertical: 10
  },
  retryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" }
});
