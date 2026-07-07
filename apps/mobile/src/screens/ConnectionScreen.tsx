import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { AuthState, ConnectionState } from "../state/sessionStore";

interface ConnectionScreenProps {
  auth: AuthState;
  connectionState: ConnectionState;
  desktopName: string | null;
  errorMessage: string | null;
  pairingCode: string | null;
  onConnectLocal(): void;
  onSignIn(email: string, password: string): void;
  onSignOut(): void;
}

export function ConnectionScreen({
  auth,
  connectionState,
  desktopName,
  errorMessage,
  pairingCode,
  onConnectLocal,
  onSignIn,
  onSignOut
}: ConnectionScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const primaryLabel =
    connectionState === "connecting" ? "Connecting..." : "Connect on Local Network";
  const authSummary = getConnectionAuthSummary(auth);
  const canSubmitAuth = email.trim().length > 0 && password.length > 0;

  return (
    <View style={styles.wrap}>
      <Text style={styles.eyebrow}>Kanna Mobile</Text>
      <Text style={styles.title}>Connection</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Cloud Auth</Text>
        <Text style={styles.cardValue}>{authSummary.title}</Text>
        <Text style={styles.cardMeta}>{authSummary.detail}</Text>

        {auth.status === "signedIn" ? (
          <Pressable style={styles.secondaryButton} onPress={onSignOut}>
            <Text style={styles.secondaryLabel}>Sign Out</Text>
          </Pressable>
        ) : (
          <View style={styles.authForm}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor="#718199"
              style={styles.input}
              value={email}
            />
            <View style={styles.passwordRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#718199"
                secureTextEntry={!isPasswordVisible}
                style={[styles.input, styles.passwordInput]}
                value={password}
              />
              <Pressable
                accessibilityLabel={isPasswordVisible ? "Hide password" : "Show password"}
                onPress={() => setIsPasswordVisible((visible) => !visible)}
                style={styles.passwordToggle}
              >
                <Text style={styles.passwordToggleLabel}>
                  {isPasswordVisible ? "Hide" : "Show"}
                </Text>
              </Pressable>
            </View>
            <Pressable
              disabled={!canSubmitAuth || auth.status === "signingIn"}
              onPress={() => onSignIn(email.trim(), password)}
              style={[
                styles.primaryButton,
                !canSubmitAuth || auth.status === "signingIn"
                  ? styles.disabledButton
                  : null
              ]}
            >
              <Text style={styles.primaryLabel}>
                {auth.status === "signingIn" ? "Signing In..." : "Sign In"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Desktop</Text>
        <Text style={styles.cardValue}>{desktopName ?? "Not paired yet"}</Text>
        <Text style={styles.cardMeta}>
          {pairingCode ? `Pairing code ${pairingCode}` : "No active pairing session"}
        </Text>
      </View>

      {errorMessage ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorLabel}>{errorMessage}</Text>
        </View>
      ) : null}

      <Pressable style={styles.primaryButton} onPress={onConnectLocal}>
        <Text style={styles.primaryLabel}>{primaryLabel}</Text>
      </Pressable>
    </View>
  );
}

export function getConnectionAuthSummary(auth: AuthState): {
  title: string;
  detail: string;
} {
  switch (auth.status) {
    case "signedIn":
      return {
        title: auth.user.email ?? auth.user.displayName ?? "Signed in",
        detail: "Signed in"
      };
    case "signingIn":
      return {
        title: "Signing in",
        detail: auth.user?.email ?? "Checking credentials"
      };
    case "error":
      return {
        title: "Sign-in error",
        detail: auth.message
      };
    case "signedOut":
    default:
      return {
        title: "Signed out",
        detail:
          "Sign in with your Kanna account, or connect to a paired desktop on your local network."
      };
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingTop: 20
  },
  eyebrow: {
    color: "#7FA7D9",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase"
  },
  title: {
    color: "#F5F7FB",
    fontSize: 28,
    fontWeight: "700"
  },
  card: {
    backgroundColor: "#10192A",
    borderColor: "#20304C",
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  cardLabel: {
    color: "#7FA7D9",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  cardValue: {
    color: "#F5F7FB",
    fontSize: 18,
    fontWeight: "700"
  },
  cardMeta: {
    color: "#9AAED0",
    fontSize: 14
  },
  authForm: {
    gap: 8
  },
  input: {
    backgroundColor: "#0B1220",
    borderColor: "#20304C",
    borderRadius: 8,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 12
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
    backgroundColor: "#152036",
    borderColor: "#22304D",
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    minWidth: 68,
    paddingHorizontal: 10
  },
  passwordToggleLabel: {
    color: "#D5DEEC",
    fontSize: 13,
    fontWeight: "700"
  },
  errorCard: {
    backgroundColor: "rgba(97, 33, 36, 0.38)",
    borderColor: "rgba(214, 102, 114, 0.34)",
    borderRadius: 16,
    borderWidth: 1,
    padding: 14
  },
  errorLabel: {
    color: "#FFC7CE",
    fontSize: 14,
    lineHeight: 20
  },
  primaryButton: {
    backgroundColor: "#E8F1FF",
    borderRadius: 8,
    paddingVertical: 14
  },
  disabledButton: {
    opacity: 0.56
  },
  primaryLabel: {
    color: "#0B1220",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center"
  },
  secondaryButton: {
    backgroundColor: "#152036",
    borderColor: "#22304D",
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 14
  },
  secondaryLabel: {
    color: "#D5DEEC",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center"
  }
});
