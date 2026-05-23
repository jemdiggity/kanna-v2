import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AuthState } from "../state/sessionStore";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

interface AccountBadgeProps {
  auth: AuthState;
  onPress(): void;
}

export function AccountBadge({ auth, onPress }: AccountBadgeProps) {
  const presentation = getAccountBadgePresentation(auth);
  const signedIn = auth.status === "signedIn";

  return (
    <Pressable
      accessibilityLabel={presentation.label}
      style={styles.badge}
      onPress={onPress}
    >
      <View style={styles.avatar}>
        <Text style={styles.initials}>{presentation.initials}</Text>
      </View>
      <View style={[styles.statusDot, signedIn ? styles.statusDotSignedIn : null]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    backgroundColor: "rgba(18, 28, 44, 0.96)",
    borderColor: "#2B3A55",
    borderRadius: 999,
    borderWidth: 1,
    height: 54,
    justifyContent: "center",
    width: 54
  },
  avatar: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  initials: {
    color: "#F5F7FB",
    fontSize: 13,
    fontWeight: "800"
  },
  statusDot: {
    backgroundColor: "#78869C",
    borderColor: "#121C2C",
    borderRadius: 999,
    borderWidth: 2,
    bottom: 8,
    height: 13,
    position: "absolute",
    right: 8,
    width: 13
  },
  statusDotSignedIn: {
    backgroundColor: "#35D978"
  }
});
