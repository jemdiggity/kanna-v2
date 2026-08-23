import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";

interface LanNotificationBannerProps {
  title: string;
  body: string;
  canOpenTask: boolean;
  onDismiss(): void;
  onOpen(): void;
}

export function LanNotificationBanner({
  title,
  body,
  canOpenTask,
  onDismiss,
  onOpen
}: LanNotificationBannerProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={styles.banner}
      testID={MOBILE_E2E_IDS.lanNotificationBanner}
    >
      <Pressable
        accessibilityRole={canOpenTask ? "button" : undefined}
        onPress={canOpenTask ? onOpen : undefined}
        style={styles.content}
        testID={MOBILE_E2E_IDS.lanNotificationOpenButton}
      >
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        <Text numberOfLines={2} style={styles.body}>{body}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Dismiss notification"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onDismiss}
        style={styles.dismiss}
        testID={MOBILE_E2E_IDS.lanNotificationDismissButton}
      >
        <Text style={styles.dismissText}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "flex-start",
    backgroundColor: "#173154",
    borderColor: "#315A88",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    left: 12,
    padding: 12,
    position: "absolute",
    right: 12,
    top: 10,
    zIndex: 30
  },
  body: {
    color: "#C8D8EE",
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2
  },
  content: {
    flex: 1
  },
  dismiss: {
    alignItems: "center",
    height: 28,
    justifyContent: "center",
    marginLeft: 8,
    marginTop: -4,
    width: 28
  },
  dismissText: {
    color: "#AFC5E2",
    fontSize: 24,
    lineHeight: 26
  },
  title: {
    color: "#F4F8FF",
    fontSize: 15,
    fontWeight: "700"
  }
});
