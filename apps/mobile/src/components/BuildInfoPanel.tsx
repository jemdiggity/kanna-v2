import * as Clipboard from "expo-clipboard";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  getCurrentBuildIdentity,
  type BuildIdentity
} from "../lib/updates/buildIdentity";
import {
  clearMobileCrashDiagnostics,
  formatMobileCrashDiagnostics,
  readMobileCrashDiagnostics,
  type MobileCrashDiagnostic
} from "../lib/diagnostics/mobileCrashDiagnostics";

const COPY_FEEDBACK_MS = 2_000;

interface BuildInfoPanelProps {
  identity?: BuildIdentity;
  copyUpdateId?(value: string): Promise<unknown>;
  copyDiagnostics?(value: string): Promise<unknown>;
  loadDiagnostics?(): Promise<MobileCrashDiagnostic[]>;
  removeDiagnostics?(): Promise<void>;
}

export function BuildInfoPanel({
  identity = getCurrentBuildIdentity(),
  copyUpdateId = Clipboard.setStringAsync,
  copyDiagnostics = Clipboard.setStringAsync,
  loadDiagnostics = readMobileCrashDiagnostics,
  removeDiagnostics = clearMobileCrashDiagnostics
}: BuildInfoPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [diagnostics, setDiagnostics] = useState<MobileCrashDiagnostic[] | null>(
    null
  );
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;

    const timeout = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    if (!expanded || diagnostics !== null) return;
    let cancelled = false;
    void loadDiagnostics().then(
      (records) => {
        if (!cancelled) {
          setDiagnostics(records);
          setDiagnosticError(null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setDiagnostics([]);
          setDiagnosticError(
            error instanceof Error
              ? error.message
              : "Could not read crash diagnostics."
          );
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [diagnostics, expanded, loadDiagnostics]);

  const handleCopy = async () => {
    if (identity.source.kind !== "ota") return;

    try {
      await copyUpdateId(identity.source.updateId);
      setCopied(true);
    } catch {
      // Build diagnostics remain usable even when the clipboard is unavailable.
    }
  };

  const handleCopyDiagnostics = async () => {
    if (!diagnostics?.length) return;
    try {
      await copyDiagnostics(formatMobileCrashDiagnostics(diagnostics));
      setDiagnosticError(null);
    } catch (error: unknown) {
      setDiagnosticError(
        error instanceof Error ? error.message : "Could not copy diagnostics."
      );
    }
  };

  const handleClearDiagnostics = async () => {
    try {
      await removeDiagnostics();
      setDiagnostics([]);
      setDiagnosticError(null);
    } catch (error: unknown) {
      setDiagnosticError(
        error instanceof Error ? error.message : "Could not clear diagnostics."
      );
    }
  };

  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [
          styles.toggle,
          pressed ? styles.togglePressed : null
        ]}
        testID={MOBILE_E2E_IDS.buildInfoToggle}
      >
        <Text style={styles.toggleLabel}>About this build</Text>
        <View style={styles.summaryGroup}>
          <Text numberOfLines={1} style={styles.summaryValue}>
            {identity.nativeSummary}
          </Text>
          <Text style={styles.chevron}>{expanded ? "⌄" : "›"}</Text>
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.details} testID={MOBILE_E2E_IDS.buildInfoDetails}>
          <InfoRow
            label="Native"
            valueTestID={MOBILE_E2E_IDS.buildInfoNative}
            value={identity.nativeSummary}
          />
          <InfoRow
            label="Runtime"
            valueTestID={MOBILE_E2E_IDS.buildInfoRuntime}
            value={identity.runtimeVersion}
          />
          <InfoRow
            label="Environment"
            valueTestID={MOBILE_E2E_IDS.buildInfoEnvironment}
            value={identity.environment}
          />
          <InfoRow
            label="Channel"
            valueTestID={MOBILE_E2E_IDS.buildInfoChannel}
            value={identity.channel}
          />
          <View style={styles.sourceRow}>
            <Text style={styles.detailLabel}>Running source</Text>
            {identity.source.kind === "ota" ? (
              <Pressable
                accessibilityHint="Copies the full Expo update ID"
                accessibilityRole="button"
                onPress={() => void handleCopy()}
                style={({ pressed }) => [
                  styles.updateIdControl,
                  pressed ? styles.updateIdPressed : null
                ]}
                testID={MOBILE_E2E_IDS.buildInfoUpdateId}
              >
                <Text
                  selectable
                  style={styles.updateId}
                  testID={MOBILE_E2E_IDS.buildInfoRunningSource}
                >
                  {identity.source.updateId}
                </Text>
                <Text
                  style={styles.copyHint}
                  testID={MOBILE_E2E_IDS.buildInfoCopyHint}
                >
                  {copied ? "Copied" : "Tap to copy"}
                </Text>
              </Pressable>
            ) : (
              <Text
                style={styles.detailValue}
                testID={MOBILE_E2E_IDS.buildInfoRunningSource}
              >
                {identity.source.label}
              </Text>
            )}
          </View>
          <View
            style={styles.diagnosticSection}
            testID={MOBILE_E2E_IDS.crashDiagnostics}
          >
            <Text style={styles.detailLabel}>Crash diagnostics</Text>
            {diagnostics === null ? (
              <Text style={styles.diagnosticSummary}>Loading…</Text>
            ) : diagnostics.length === 0 ? (
              <Text style={styles.diagnosticSummary}>
                {diagnosticError ?? "No retained crash diagnostics."}
              </Text>
            ) : (
              <>
                <Text selectable style={styles.diagnosticSummary}>
                  {`${diagnostics[0].kind} · ${diagnostics[0].at}\n${diagnostics[0].id}\n${diagnostics[0].message}`}
                </Text>
                <View style={styles.diagnosticActions}>
                  <Pressable
                    accessibilityHint="Copies the retained crash records and runtime context"
                    accessibilityRole="button"
                    onPress={() => void handleCopyDiagnostics()}
                    style={({ pressed }) => [
                      styles.diagnosticButton,
                      pressed ? styles.updateIdPressed : null
                    ]}
                    testID={MOBILE_E2E_IDS.crashDiagnosticsCopy}
                  >
                    <Text style={styles.copyHint}>Copy diagnostics</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleClearDiagnostics()}
                    style={({ pressed }) => [
                      styles.diagnosticButton,
                      pressed ? styles.updateIdPressed : null
                    ]}
                    testID={MOBILE_E2E_IDS.crashDiagnosticsClear}
                  >
                    <Text style={styles.copyHint}>Clear</Text>
                  </Pressable>
                </View>
              </>
            )}
            {diagnosticError && (diagnostics?.length ?? 0) > 0 ? (
              <Text style={styles.diagnosticError}>{diagnosticError}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function InfoRow({
  label,
  valueTestID,
  value
}: {
  label: string;
  valueTestID: string;
  value: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue} testID={valueTestID}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderTopColor: "#22304D",
    borderTopWidth: 1,
    marginTop: 4
  },
  toggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 3,
    paddingVertical: 12
  },
  togglePressed: { opacity: 0.72 },
  toggleLabel: { color: "#93A7C8", fontSize: 13, fontWeight: "700" },
  summaryGroup: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: 8,
    justifyContent: "flex-end"
  },
  summaryValue: {
    color: "#A8B7CC",
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "700"
  },
  chevron: { color: "#6883A8", fontSize: 22, fontWeight: "300" },
  details: {
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  detailRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  sourceRow: { gap: 7 },
  detailLabel: { color: "#93A7C8", fontSize: 12, fontWeight: "700" },
  detailValue: {
    color: "#F5F7FB",
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right"
  },
  updateIdControl: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 12,
    borderWidth: 1,
    gap: 5,
    padding: 10
  },
  updateIdPressed: { backgroundColor: "#182842", opacity: 0.82 },
  updateId: {
    color: "#EAF3FF",
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 17
  },
  copyHint: { color: "#7FA7D9", fontSize: 11, fontWeight: "700" },
  diagnosticSection: {
    borderTopColor: "#22304D",
    borderTopWidth: 1,
    gap: 8,
    paddingTop: 10
  },
  diagnosticSummary: {
    color: "#D8E7F7",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16
  },
  diagnosticActions: { flexDirection: "row", gap: 8 },
  diagnosticButton: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 10,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 12
  },
  diagnosticError: { color: "#FFC7CE", fontSize: 11, lineHeight: 16 }
});
