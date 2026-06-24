import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

interface UpdateReadyBannerProps {
  onDismiss(): void;
  onRestart(): void;
}

export function UpdateReadyBanner({
  onDismiss,
  onRestart
}: UpdateReadyBannerProps) {
  return (
    <View style={styles.banner} testID={MOBILE_E2E_IDS.updateReadyBanner}>
      <View style={styles.copy}>
        <Text style={styles.title}>Update ready</Text>
        <Text style={styles.detail}>Restart to apply</Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="Dismiss update"
          style={styles.dismissButton}
          testID={MOBILE_E2E_IDS.updateReadyDismissButton}
          onPress={onDismiss}
        >
          <Text style={styles.dismissLabel}>Dismiss</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Restart to apply update"
          style={styles.restartButton}
          testID={MOBILE_E2E_IDS.updateReadyRestartButton}
          onPress={onRestart}
        >
          <Text style={styles.restartLabel}>Restart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: "#E8F1FF",
    borderColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    bottom: 96,
    flexDirection: "row",
    gap: 12,
    left: 0,
    padding: 12,
    position: "absolute",
    right: 0,
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 18
  },
  copy: {
    flex: 1
  },
  title: {
    color: "#0B1220",
    fontSize: 15,
    fontWeight: "800"
  },
  detail: {
    color: "#40516C",
    fontSize: 12,
    marginTop: 2
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  dismissButton: {
    paddingHorizontal: 6,
    paddingVertical: 8
  },
  dismissLabel: {
    color: "#40516C",
    fontSize: 12,
    fontWeight: "800"
  },
  restartButton: {
    backgroundColor: "#0B1220",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  restartLabel: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800"
  }
});
