import * as Clipboard from "expo-clipboard";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  getCurrentBuildIdentity,
  type BuildIdentity
} from "../lib/updates/buildIdentity";

const COPY_FEEDBACK_MS = 2_000;

interface BuildInfoPanelProps {
  identity?: BuildIdentity;
  copyUpdateId?(value: string): Promise<unknown>;
}

export function BuildInfoPanel({
  identity = getCurrentBuildIdentity(),
  copyUpdateId = Clipboard.setStringAsync
}: BuildInfoPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeout = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    if (identity.source.kind !== "ota") return;

    try {
      await copyUpdateId(identity.source.updateId);
      setCopied(true);
    } catch {
      // Build diagnostics remain usable even when the clipboard is unavailable.
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
  copyHint: { color: "#7FA7D9", fontSize: 11, fontWeight: "700" }
});
