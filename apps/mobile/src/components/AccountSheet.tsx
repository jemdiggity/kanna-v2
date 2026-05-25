import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import type { AuthState } from "../state/sessionStore";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

interface AccountSheetProps {
  auth: AuthState;
  visible: boolean;
  onClose(): void;
  onSignIn(email: string, password: string): void;
  onSignOut(): void;
}

export function AccountSheet({
  auth,
  visible,
  onClose,
  onSignIn,
  onSignOut
}: AccountSheetProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const presentation = getAccountBadgePresentation(auth);
  const canSubmit = email.trim().length > 3 && password.length > 0;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{presentation.label}</Text>
              <Text style={styles.detail}>{presentation.detail}</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeLabel}>×</Text>
            </Pressable>
          </View>

          {auth.status === "signedIn" ? (
            <Pressable style={styles.secondaryButton} onPress={onSignOut}>
              <Text style={styles.secondaryLabel}>Sign Out</Text>
            </Pressable>
          ) : (
            <View style={styles.form}>
              <TextInput
                autoCapitalize="none"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor="#6A7E9D"
                style={styles.input}
                value={email}
              />
              <TextInput
                autoCapitalize="none"
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#6A7E9D"
                secureTextEntry
                style={styles.input}
                value={password}
              />
              {auth.status === "error" ? (
                <Text style={styles.errorText}>{auth.message}</Text>
              ) : null}
              <Pressable
                disabled={!canSubmit || auth.status === "signingIn"}
                style={[
                  styles.primaryButton,
                  !canSubmit || auth.status === "signingIn"
                    ? styles.primaryButtonDisabled
                    : null
                ]}
                onPress={() => onSignIn(email.trim(), password)}
              >
                <Text style={styles.primaryLabel}>
                  {auth.status === "signingIn" ? "Signing In..." : "Sign In"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end"
  },
  scrim: {
    backgroundColor: "rgba(2, 6, 14, 0.62)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  sheet: {
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    gap: 18,
    padding: 20,
    paddingBottom: 38
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  title: {
    color: "#F5F7FB",
    fontSize: 20,
    fontWeight: "800"
  },
  detail: {
    color: "#9EB0CA",
    fontSize: 13,
    marginTop: 4
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "#172338",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  closeLabel: {
    color: "#F5F7FB",
    fontSize: 24,
    lineHeight: 26
  },
  form: {
    gap: 12
  },
  input: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 13
  },
  errorText: {
    color: "#FFC7CE",
    fontSize: 13,
    lineHeight: 18
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#E8F1FF",
    borderRadius: 16,
    paddingVertical: 14
  },
  primaryButtonDisabled: {
    opacity: 0.5
  },
  primaryLabel: {
    color: "#0B1220",
    fontSize: 15,
    fontWeight: "800"
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#172338",
    borderColor: "#2A3957",
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 14
  },
  secondaryLabel: {
    color: "#F5F7FB",
    fontSize: 15,
    fontWeight: "800"
  }
});
