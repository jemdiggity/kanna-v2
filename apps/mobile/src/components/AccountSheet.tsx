import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { AuthState, ConnectionState } from "../state/sessionStore";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

interface AccountSheetProps {
  auth: AuthState;
  connectionState: ConnectionState;
  desktopName: string | null;
  errorMessage: string | null;
  pairingCode: string | null;
  visible: boolean;
  forceCloudEnabled: boolean;
  showDevForceCloudToggle: boolean;
  onConnectLocal(): void;
  onClose(): void;
  onForceCloudChange(enabled: boolean): void;
  onSignIn(email: string, password: string): void;
  onSignOut(): void;
}

export function AccountSheet({
  auth,
  connectionState,
  desktopName,
  errorMessage,
  forceCloudEnabled,
  pairingCode,
  showDevForceCloudToggle,
  visible,
  onConnectLocal,
  onClose,
  onForceCloudChange,
  onSignIn,
  onSignOut
}: AccountSheetProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const presentation = getAccountBadgePresentation(auth);
  const connection = getConnectionStatusPresentation(
    connectionState,
    desktopName,
    pairingCode,
    errorMessage
  );
  const canSubmit = email.trim().length > 3 && password.length > 0;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet} testID={MOBILE_E2E_IDS.accountSheet}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{presentation.label}</Text>
              <Text style={styles.detail}>{presentation.detail}</Text>
            </View>
            <Pressable
              accessibilityLabel="Close account"
              style={styles.closeButton}
              testID={MOBILE_E2E_IDS.accountCloseButton}
              onPress={onClose}
            >
              <Text style={styles.closeLabel}>×</Text>
            </Pressable>
            {showDevForceCloudToggle ? (
              <Pressable
                accessibilityLabel="Force Cloud"
                accessibilityState={{ checked: forceCloudEnabled }}
                style={styles.devToggle}
                testID={MOBILE_E2E_IDS.accountForceCloudToggle}
                onPress={() => onForceCloudChange(!forceCloudEnabled)}
              >
                <View
                  style={[
                    styles.devToggleIndicator,
                    forceCloudEnabled ? styles.devToggleIndicatorActive : null
                  ]}
                />
                <View style={styles.devToggleText}>
                  <Text style={styles.devToggleTitle}>Force Cloud</Text>
                  <Text style={styles.devToggleDetail}>
                    {forceCloudEnabled ? "Relay only" : "LAN fallback allowed"}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </View>

          <View
            style={styles.connectionCard}
            testID={MOBILE_E2E_IDS.accountConnectionStatus}
          >
            <Text style={styles.sectionLabel}>Connection</Text>
            <Text
              style={styles.connectionTitle}
              testID={MOBILE_E2E_IDS.accountConnectionTitle}
            >
              {connection.title}
            </Text>
            <Text style={styles.connectionDetail}>{connection.detail}</Text>
            <Pressable
              accessibilityLabel="Connect on Local Network"
              style={styles.secondaryButton}
              testID={MOBILE_E2E_IDS.accountConnectLocalButton}
              onPress={onConnectLocal}
            >
              <Text style={styles.secondaryLabel}>
                {connectionState === "connecting"
                  ? "Connecting..."
                  : "Connect on Local Network"}
              </Text>
            </Pressable>
          </View>

          {auth.status === "signedIn" ? (
            <Pressable
              accessibilityLabel="Sign Out"
              style={styles.secondaryButton}
              testID={MOBILE_E2E_IDS.accountSignOutButton}
              onPress={onSignOut}
            >
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
                testID={MOBILE_E2E_IDS.accountEmailInput}
                value={email}
              />
              <View style={styles.passwordRow}>
                <TextInput
                  autoCapitalize="none"
                  onChangeText={setPassword}
                  placeholder="Password"
                  placeholderTextColor="#6A7E9D"
                  secureTextEntry={!isPasswordVisible}
                  style={[styles.input, styles.passwordInput]}
                  testID={MOBILE_E2E_IDS.accountPasswordInput}
                  value={password}
                />
                <Pressable
                  accessibilityLabel={isPasswordVisible ? "Hide password" : "Show password"}
                  style={styles.passwordToggle}
                  testID={MOBILE_E2E_IDS.accountPasswordToggle}
                  onPress={() => setIsPasswordVisible((visible) => !visible)}
                >
                  <Text style={styles.passwordToggleLabel}>
                    {isPasswordVisible ? "Hide" : "Show"}
                  </Text>
                </Pressable>
              </View>
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
                testID={MOBILE_E2E_IDS.accountSignInButton}
                onPress={() => onSignIn(email.trim(), password)}
              >
                <Text style={styles.primaryLabel}>
                  {auth.status === "signingIn" ? "Signing In..." : "Sign In"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function getConnectionStatusPresentation(
  connectionState: ConnectionState,
  desktopName: string | null,
  pairingCode: string | null,
  errorMessage: string | null
): { title: string; detail: string } {
  if (connectionState === "connected") {
    return {
      title: desktopName ?? "Connected",
      detail: pairingCode ? `Pairing code ${pairingCode}` : "Connected"
    };
  }

  if (connectionState === "connecting") {
    return {
      title: "Connecting",
      detail: pairingCode ? `Pairing code ${pairingCode}` : "Checking desktop access"
    };
  }

  if (connectionState === "error") {
    return {
      title: "Not connected",
      detail: errorMessage ?? "Connection failed"
    };
  }

  return {
    title: "Not connected",
    detail: pairingCode ? `Pairing code ${pairingCode}` : "No active pairing session"
  };
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
  connectionCard: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  devToggle: {
    alignItems: "center",
    borderColor: "#2D4166",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
    padding: 10
  },
  devToggleDetail: {
    color: "#8FA4C0",
    fontSize: 12,
    marginTop: 2
  },
  devToggleIndicator: {
    backgroundColor: "#1A2740",
    borderColor: "#3B5278",
    borderRadius: 7,
    borderWidth: 1,
    height: 14,
    width: 14
  },
  devToggleIndicatorActive: {
    backgroundColor: "#56A2FF",
    borderColor: "#8EC2FF"
  },
  devToggleText: {
    flex: 1
  },
  devToggleTitle: {
    color: "#F5F7FB",
    fontSize: 13,
    fontWeight: "700"
  },
  sectionLabel: {
    color: "#7FA7D9",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  connectionTitle: {
    color: "#F5F7FB",
    fontSize: 17,
    fontWeight: "800"
  },
  connectionDetail: {
    color: "#9EB0CA",
    fontSize: 13,
    lineHeight: 18
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
  passwordRow: {
    alignItems: "stretch",
    flexDirection: "row",
    gap: 8
  },
  passwordInput: {
    flex: 1
  },
  passwordToggle: {
    alignItems: "center",
    backgroundColor: "#172338",
    borderColor: "#2A3957",
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    minWidth: 72,
    paddingHorizontal: 12
  },
  passwordToggleLabel: {
    color: "#F5F7FB",
    fontSize: 13,
    fontWeight: "800"
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
