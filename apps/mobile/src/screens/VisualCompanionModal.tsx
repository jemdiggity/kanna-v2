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
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type {
  TaskCompanionEventStatus,
  TaskCompanionStatus
} from "../state/sessionStore";
import { buildVisualCompanionDocument } from "./buildVisualCompanionDocument";

const WebView = NativeWebView as unknown as React.ComponentType<WebViewProps>;
const MAX_BRIDGE_MESSAGE_BYTES = 8 * 1024;
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = true
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    utf8ByteLength(value) <= maxBytes
  );
}

function parseCompanionEvent(data: string): CompanionEvent | null {
  if (utf8ByteLength(data) > MAX_BRIDGE_MESSAGE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (
    !hasOnlyKeys(message, ["event", "type"]) ||
    message.type !== "companion-event" ||
    typeof message.event !== "object" ||
    message.event === null ||
    Array.isArray(message.event)
  ) {
    return null;
  }

  const event = message.event as Record<string, unknown>;
  if (
    !hasOnlyKeys(event, [
      "choice",
      "event_id",
      "id",
      "text",
      "timestamp",
      "type"
    ]) ||
    event.type !== "click" ||
    !isBoundedString(event.event_id, 128, false) ||
    !isBoundedString(event.choice, 256, false) ||
    !isBoundedString(event.text, 4 * 1024) ||
    !(event.id === null || isBoundedString(event.id, 256)) ||
    typeof event.timestamp !== "number" ||
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp < 0
  ) {
    return null;
  }

  return {
    event_id: event.event_id,
    type: "click",
    choice: event.choice,
    text: event.text,
    id: event.id,
    timestamp: event.timestamp
  };
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
  const document = useMemo(
    () =>
      snapshot
        ? buildVisualCompanionDocument({
            documentKind: snapshot.documentKind,
            html: snapshot.html
          })
        : null,
    [snapshot?.documentKind, snapshot?.html, snapshot?.revision]
  );

  const statusMessage = localErrorMessage
    ? `Couldn’t send selection: ${localErrorMessage}`
    : errorMessage
      ? errorMessage
      : eventStatus === "sending"
        ? "Sending selection…"
        : eventStatus === "sent"
          ? "Selection sent."
          : status === "unavailable"
            ? "This visual companion has ended."
            : status === "error" && !snapshot
              ? "The visual companion is unavailable."
              : !snapshot
                ? "Waiting for visual companion…"
                : null;

  const handleMessage = (message: WebViewMessageEvent) => {
    if (!snapshot) return;
    const event = parseCompanionEvent(message.nativeEvent.data);
    if (!event) return;

    try {
      onSendEvent(snapshot.sessionId, snapshot.revision, event);
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

        {document && snapshot ? (
          <WebView
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            allowsLinkPreview={false}
            cacheEnabled={false}
            domStorageEnabled={false}
            javaScriptCanOpenWindowsAutomatically={false}
            javaScriptEnabled
            key={`${snapshot.sessionId}:${snapshot.revision}`}
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
