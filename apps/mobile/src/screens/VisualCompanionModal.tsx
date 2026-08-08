import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  WebView as NativeWebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
  type WebViewProps
} from "react-native-webview";
import type {
  CompanionDocumentKind,
  CompanionEvent
} from "@kanna/agent-protocol";
import { parseCompanionBridgeEvent } from "@kanna/visual-companion";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type {
  TaskCompanionEventStatus,
  TaskCompanionStatus
} from "../state/sessionStore";
import { buildVisualCompanionDocument } from "./buildVisualCompanionDocument";

const WebView = NativeWebView as unknown as React.ComponentType<WebViewProps>;
const ENABLE_E2E_WEBVIEW_INSPECTION =
  process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED === "1";

export interface VisualCompanionSnapshot {
  sessionId: string;
  revision: string;
  documentKind: CompanionDocumentKind;
  html: string;
}

export interface VisualCompanionModalProps {
  status: TaskCompanionStatus;
  snapshot: VisualCompanionSnapshot | null;
  errorMessage: string | null;
  eventStatus: TaskCompanionEventStatus;
  onClose(): void;
  onSendEvent(
    sessionId: string,
    revision: string,
    event: CompanionEvent
  ): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function VisualCompanionModal({
  status,
  snapshot,
  errorMessage,
  eventStatus,
  onClose,
  onSendEvent
}: VisualCompanionModalProps) {
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);
  const interactiveSnapshot = status === "available" ? snapshot : null;
  const document = useMemo(
    () =>
      interactiveSnapshot
        ? buildVisualCompanionDocument({
            documentKind: interactiveSnapshot.documentKind,
            html: interactiveSnapshot.html
          })
        : null,
    [
      interactiveSnapshot?.documentKind,
      interactiveSnapshot?.html,
      interactiveSnapshot?.revision
    ]
  );

  const statusMessage = localErrorMessage
    ? `Couldn’t send selection: ${localErrorMessage}`
    : errorMessage
      ? errorMessage
      : eventStatus === "sending"
        ? "Sending selection…"
        : eventStatus === "sent"
          ? "Selection sent."
          : status === "reconnecting"
            ? "Reconnecting to visual companion…"
            : status === "unavailable"
              ? "This visual companion has ended."
              : status === "error" && !snapshot
                ? "The visual companion is unavailable."
                : !snapshot
                  ? "Waiting for visual companion…"
                  : null;

  const handleMessage = (message: WebViewMessageEvent) => {
    if (!interactiveSnapshot) return;
    const event = parseCompanionBridgeEvent(
      message.nativeEvent.data,
      interactiveSnapshot.sessionId,
      interactiveSnapshot.revision
    );
    if (!event) return;

    try {
      onSendEvent(
        interactiveSnapshot.sessionId,
        interactiveSnapshot.revision,
        event
      );
      setLocalErrorMessage(null);
    } catch (error) {
      setLocalErrorMessage(errorText(error));
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible
    >
      <SafeAreaView
        style={styles.safeArea}
        testID={MOBILE_E2E_IDS.visualCompanionModal}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Visual companion</Text>
            <Text style={styles.subtitle}>
              Interactive view from your agent
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onClose}
            style={styles.closeButton}
            testID={MOBILE_E2E_IDS.visualCompanionClose}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        {statusMessage ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.status}
            testID={MOBILE_E2E_IDS.visualCompanionStatus}
          >
            {statusMessage}
          </Text>
        ) : null}

        {document && interactiveSnapshot ? (
          <WebView
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            allowsLinkPreview={false}
            cacheEnabled={false}
            domStorageEnabled={false}
            javaScriptCanOpenWindowsAutomatically={false}
            javaScriptEnabled
            key={`${interactiveSnapshot.sessionId}:${interactiveSnapshot.revision}`}
            mixedContentMode="never"
            onMessage={handleMessage}
            onShouldStartLoadWithRequest={(request: WebViewNavigation) =>
              request.url === "about:blank"
            }
            originWhitelist={["about:blank"]}
            setSupportMultipleWindows={false}
            sharedCookiesEnabled={false}
            source={{ html: document }}
            style={styles.webView}
            testID={MOBILE_E2E_IDS.visualCompanionWebView}
            thirdPartyCookiesEnabled={false}
            webviewDebuggingEnabled={ENABLE_E2E_WEBVIEW_INSPECTION}
          />
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              {status === "unavailable"
                ? "Return to the task to continue."
                : status === "reconnecting"
                  ? "Interaction will resume after the latest screen loads."
                : "The view will appear here when it is ready."}
            </Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#050B14",
    flex: 1
  },
  header: {
    alignItems: "center",
    borderBottomColor: "#1D2C43",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 13
  },
  headerCopy: {
    flex: 1
  },
  title: {
    color: "#F4F8FF",
    fontSize: 17,
    fontWeight: "700"
  },
  subtitle: {
    color: "#8292A9",
    fontSize: 12,
    marginTop: 3
  },
  closeButton: {
    borderColor: "#31415B",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  closeText: {
    color: "#D7E2F0",
    fontSize: 14,
    fontWeight: "600"
  },
  status: {
    backgroundColor: "#18253A",
    color: "#D7E2F0",
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 18,
    paddingVertical: 10
  },
  webView: {
    backgroundColor: "#050B14",
    flex: 1
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28
  },
  emptyStateText: {
    color: "#AEBBD0",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center"
  }
});
