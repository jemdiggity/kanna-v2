import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { AuthState } from "../state/sessionStore";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

export const CLOUD_ACCESS_REQUEST_URL = "https://kanna.build/support";

interface AccountSheetProps {
  auth: AuthState;
  machineCount: number;
  availableMachineCount: number;
  quickRepliesReady: boolean;
  visible: boolean;
  onClose(): void;
  onOpenMachines(): void;
  onOpenQuickReplies(): void;
  onSignIn(email: string, password: string): void;
  onSignOut(): void;
  onDeleteAccount?(): Promise<void>;
}

export function AccountSheet({
  auth,
  machineCount,
  availableMachineCount,
  quickRepliesReady,
  visible,
  onClose,
  onOpenMachines,
  onOpenQuickReplies,
  onSignIn,
  onSignOut,
  onDeleteAccount
}: AccountSheetProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [deletionVisible, setDeletionVisible] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const presentation = getAccountBadgePresentation(auth);
  const canSubmit = email.trim().length > 3 && password.length > 0;
  const closeSheet = () => {
    setIsPasswordVisible(false);
    onClose();
  };
  const signOut = () => {
    setIsPasswordVisible(false);
    onSignOut();
  };
  const confirmDeletion = async () => {
    if (deletionConfirmation !== "DELETE" || !onDeleteAccount) return;
    setDeletionPending(true);
    setDeletionError("");
    try {
      await onDeleteAccount();
      setDeletionVisible(false);
      setDeletionConfirmation("");
    } catch (error) {
      setDeletionError(
        error instanceof Error ? error.message : "Could not delete your account.",
      );
    } finally {
      setDeletionPending(false);
    }
  };

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={closeSheet}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <Pressable style={styles.scrim} onPress={closeSheet} />
        <View style={styles.sheet} testID={MOBILE_E2E_IDS.accountSheet}>
          <View style={styles.header}>
            <View style={styles.identity}>
              <View
                accessibilityLabel={`Account initials ${presentation.initials}`}
                style={styles.avatar}
              >
                <Text style={styles.avatarLabel}>{presentation.initials}</Text>
              </View>
              <View>
                <Text style={styles.title}>{presentation.label}</Text>
                <Text style={styles.detail}>{presentation.detail}</Text>
              </View>
            </View>
            <Pressable
              accessibilityLabel="Close account"
              style={styles.closeButton}
              testID={MOBILE_E2E_IDS.accountCloseButton}
              onPress={closeSheet}
            >
              <Text style={styles.closeLabel}>×</Text>
            </Pressable>
          </View>

          <Pressable
            accessibilityLabel="Open Machines"
            style={styles.machinesRow}
            testID={MOBILE_E2E_IDS.accountMachinesButton}
            onPress={onOpenMachines}
          >
            <View>
              <Text style={styles.machinesTitle}>Machines</Text>
              <Text style={styles.machinesDetail}>
                {machineSummary(machineCount, availableMachineCount)}
              </Text>
            </View>
            <Text style={styles.disclosure}>›</Text>
          </Pressable>

          <Pressable
            accessibilityLabel="Open Quick Replies"
            accessibilityState={{ disabled: !quickRepliesReady }}
            disabled={!quickRepliesReady}
            style={[
              styles.machinesRow,
              !quickRepliesReady ? styles.disabledRow : null
            ]}
            testID={MOBILE_E2E_IDS.accountQuickRepliesButton}
            onPress={onOpenQuickReplies}
          >
            <View>
              <Text style={styles.machinesTitle}>Quick Replies</Text>
              <Text style={styles.machinesDetail}>
                {quickRepliesReady
                  ? "Customize hold-and-drag replies"
                  : "Loading saved replies…"}
              </Text>
            </View>
            <Text style={styles.disclosure}>›</Text>
          </Pressable>

          {auth.status === "signedIn" ? (
            <View style={styles.form}>
              <Pressable
                accessibilityLabel="Sign Out"
                style={styles.secondaryButton}
                testID={MOBILE_E2E_IDS.accountSignOutButton}
                onPress={signOut}
              >
                <Text style={styles.secondaryLabel}>Sign Out</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Delete account"
                style={styles.deleteButton}
                testID={MOBILE_E2E_IDS.accountDeleteButton}
                onPress={() => setDeletionVisible(true)}
              >
                <Text style={styles.deleteLabel}>Delete account</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={styles.accessNotice}>
                Cloud access is invite-only.{" "}
                <Text
                  accessibilityLabel="Request cloud access"
                  accessibilityRole="link"
                  onPress={() => {
                    void Linking.openURL(CLOUD_ACCESS_REQUEST_URL);
                  }}
                  style={styles.accessNoticeLink}
                >
                  Request access.
                </Text>
              </Text>
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
      <Modal
        animationType="fade"
        transparent
        visible={visible && deletionVisible}
        onRequestClose={() => setDeletionVisible(false)}
      >
        <View style={styles.confirmationBackdrop}>
          <View style={styles.confirmationCard} testID={MOBILE_E2E_IDS.accountDeleteConfirmation}>
            <Text style={styles.confirmationTitle}>Permanently delete account?</Text>
            <Text style={styles.confirmationCopy}>
              This immediately cancels your subscription and permanently deletes your cloud data
              and cloud desktop pairings. Local Kanna data and LAN pairings stay on your devices.
              This cannot be undone.
            </Text>
            <Text style={styles.confirmationCopy}>Type DELETE to continue.</Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!deletionPending}
              onChangeText={setDeletionConfirmation}
              placeholder="DELETE"
              placeholderTextColor="#6A7E9D"
              style={styles.input}
              testID={MOBILE_E2E_IDS.accountDeleteInput}
              value={deletionConfirmation}
            />
            {deletionError ? <Text style={styles.errorText}>{deletionError}</Text> : null}
            <View style={styles.confirmationActions}>
              <Pressable
                disabled={deletionPending}
                style={styles.secondaryButton}
                onPress={() => setDeletionVisible(false)}
              >
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={deletionConfirmation !== "DELETE" || deletionPending}
                style={[
                  styles.deleteConfirmButton,
                  deletionConfirmation !== "DELETE" || deletionPending
                    ? styles.primaryButtonDisabled
                    : null,
                ]}
                testID={MOBILE_E2E_IDS.accountDeleteConfirmButton}
                onPress={() => void confirmDeletion()}
              >
                <Text style={styles.deleteConfirmLabel}>
                  {deletionPending ? "Deleting…" : "Delete permanently"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

function machineSummary(total: number, available: number): string {
  if (total === 0) return "No machines added";
  return `${total} ${total === 1 ? "machine" : "machines"} · ${available} available`;
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
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  avatar: {
    alignItems: "center",
    backgroundColor: "#2C5EA8",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  avatarLabel: {
    color: "#F5F7FB",
    fontSize: 14,
    fontWeight: "800"
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
  accessNotice: {
    color: "#9EB0CA",
    fontSize: 13,
    lineHeight: 18
  },
  accessNoticeLink: {
    color: "#8EADD8",
    fontWeight: "800"
  },
  machinesRow: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14
  },
  disabledRow: {
    opacity: 0.55
  },
  machinesTitle: {
    color: "#F5F7FB",
    fontSize: 15,
    fontWeight: "800"
  },
  machinesDetail: {
    color: "#9EB0CA",
    fontSize: 13,
    marginTop: 3
  },
  disclosure: {
    color: "#8EADD8",
    fontSize: 26
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
  },
  deleteButton: {
    alignItems: "center",
    paddingVertical: 10
  },
  deleteLabel: {
    color: "#FF9CA5",
    fontSize: 14,
    fontWeight: "800"
  },
  confirmationBackdrop: {
    backgroundColor: "rgba(2, 6, 14, 0.78)",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  confirmationCard: {
    backgroundColor: "#0D1727",
    borderColor: "#394761",
    borderRadius: 20,
    borderWidth: 1,
    gap: 14,
    padding: 20
  },
  confirmationTitle: {
    color: "#F5F7FB",
    fontSize: 20,
    fontWeight: "800"
  },
  confirmationCopy: {
    color: "#C3CEE0",
    fontSize: 14,
    lineHeight: 20
  },
  confirmationActions: {
    gap: 10
  },
  deleteConfirmButton: {
    alignItems: "center",
    backgroundColor: "#A92B38",
    borderRadius: 16,
    paddingVertical: 14
  },
  deleteConfirmLabel: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800"
  }
});
