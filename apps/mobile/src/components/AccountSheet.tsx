import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { validateCustomRelayUrl } from "../relaySettings";
import type { AuthState } from "../state/sessionStore";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

interface AccountSheetProps {
  auth: AuthState;
  machineCount: number;
  availableMachineCount: number;
  customRelayUrl: string | null;
  defaultRelayUrl: string | null;
  quickRepliesReady: boolean;
  visible: boolean;
  onClose(): void;
  onOpenMachines(): void;
  onOpenQuickReplies(): void;
  onSignIn(email: string, password: string): void;
  onCreateAccount(email: string, password: string): void;
  onRefreshAccount(): void;
  onSignOut(): void;
  onSaveCustomRelayUrl(relayUrl: string | null): Promise<void>;
  subscriptionUrl: string;
  onDeleteAccount?(): Promise<void>;
}

export function AccountSheet({
  auth,
  machineCount,
  availableMachineCount,
  customRelayUrl,
  defaultRelayUrl,
  quickRepliesReady,
  visible,
  onClose,
  onOpenMachines,
  onOpenQuickReplies,
  onSignIn,
  onCreateAccount,
  onRefreshAccount,
  onSignOut,
  onSaveCustomRelayUrl,
  subscriptionUrl,
  onDeleteAccount
}: AccountSheetProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [submissionMode, setSubmissionMode] = useState<"signIn" | "create">("signIn");
  const [deletionVisible, setDeletionVisible] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const [relayDraft, setRelayDraft] = useState<string | null>(null);
  const [relaySaveError, setRelaySaveError] = useState("");
  const [relaySavePending, setRelaySavePending] = useState(false);
  const presentation = getAccountBadgePresentation(auth);
  const canSubmit = email.trim().length > 3 && password.length > 0;
  const canCreate = email.trim().length > 3 && password.length >= 6;
  const displayedRelayDraft = relayDraft ?? customRelayUrl ?? "";
  const relayValidationError = displayedRelayDraft.trim()
    ? validateCustomRelayUrl(displayedRelayDraft)
    : null;
  const saveRelay = async (relayUrl: string | null) => {
    setRelaySavePending(true);
    setRelaySaveError("");
    try {
      await onSaveCustomRelayUrl(relayUrl);
      setRelayDraft(null);
    } catch (error) {
      setRelaySaveError(
        error instanceof Error ? error.message : "Could not save the relay URL."
      );
    } finally {
      setRelaySavePending(false);
    }
  };
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
      setDeletionError(error instanceof Error ? error.message : "Could not delete your account.");
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
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <View style={styles.identity}>
                <View
                  accessibilityLabel={`Account initials ${presentation.initials}`}
                  style={styles.avatar}
                >
                  <Text style={styles.avatarLabel}>{presentation.initials}</Text>
                </View>
                <View style={styles.identityCopy}>
                  <Text numberOfLines={1} style={styles.title}>
                    {presentation.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.detail}>
                    {presentation.detail}
                  </Text>
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
              style={[styles.machinesRow, !quickRepliesReady ? styles.disabledRow : null]}
              testID={MOBILE_E2E_IDS.accountQuickRepliesButton}
              onPress={onOpenQuickReplies}
            >
              <View>
                <Text style={styles.machinesTitle}>Quick Replies</Text>
                <Text style={styles.machinesDetail}>
                  {quickRepliesReady ? "Customize hold-and-drag replies" : "Loading saved replies…"}
                </Text>
              </View>
              <Text style={styles.disclosure}>›</Text>
            </Pressable>

            <View style={styles.relayCard} testID={MOBILE_E2E_IDS.accountRelaySettings}>
              <View style={styles.relayHeadingRow}>
                <Text style={styles.machinesTitle}>Relay connection</Text>
                <View style={customRelayUrl ? styles.customRelayBadge : styles.defaultRelayBadge}>
                  <Text style={styles.relayBadgeLabel}>
                    {customRelayUrl ? "Using custom relay" : "Using default relay"}
                  </Text>
                </View>
              </View>
              <Text style={styles.accountStateCopy}>
                {customRelayUrl ?? defaultRelayUrl ?? "Relay disabled for this build"}
              </Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!relaySavePending}
                keyboardType="url"
                onChangeText={(value) => {
                  setRelayDraft(value);
                  setRelaySaveError("");
                }}
                placeholder="wss://relay.example.com"
                placeholderTextColor="#6A7E9D"
                style={styles.input}
                testID={MOBILE_E2E_IDS.accountRelayInput}
                value={displayedRelayDraft}
              />
              {relayValidationError || relaySaveError ? (
                <Text style={styles.errorText} testID={MOBILE_E2E_IDS.accountRelayError}>
                  {relayValidationError ?? relaySaveError}
                </Text>
              ) : null}
              <View style={styles.relayActions}>
                <Pressable
                  accessibilityLabel="Save custom relay"
                  disabled={
                    relaySavePending ||
                    !displayedRelayDraft.trim() ||
                    relayValidationError !== null ||
                    displayedRelayDraft.trim() === customRelayUrl
                  }
                  style={[
                    styles.primaryButton,
                    relaySavePending ||
                    !displayedRelayDraft.trim() ||
                    relayValidationError !== null ||
                    displayedRelayDraft.trim() === customRelayUrl
                      ? styles.primaryButtonDisabled
                      : null
                  ]}
                  testID={MOBILE_E2E_IDS.accountRelaySaveButton}
                  onPress={() => void saveRelay(displayedRelayDraft.trim())}
                >
                  <Text style={styles.primaryLabel}>
                    {relaySavePending ? "Saving…" : "Use custom relay"}
                  </Text>
                </Pressable>
                {customRelayUrl ? (
                  <Pressable
                    accessibilityLabel="Reset to default relay"
                    disabled={relaySavePending}
                    style={styles.secondaryButton}
                    testID={MOBILE_E2E_IDS.accountRelayResetButton}
                    onPress={() => void saveRelay(null)}
                  >
                    <Text style={styles.secondaryLabel}>Reset to default</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.relayHelp}>
                Self-hosted relays still require a signed-in Kanna account. Use a valid TLS
                certificate; iOS requires a secure wss:// endpoint.
              </Text>
            </View>

            {auth.status === "signedIn" ? (
              <View style={styles.form}>
                {auth.user.emailVerified === false ? (
                  <View
                    style={styles.accountState}
                    testID={MOBILE_E2E_IDS.accountVerificationState}
                  >
                    <Text style={styles.accountStateTitle}>Verify your email</Text>
                    <Text style={styles.accountStateCopy}>
                      We sent a verification link to {auth.user.email}. Open it, then return here.
                    </Text>
                    <Pressable
                      accessibilityLabel="Check email verification"
                      style={styles.primaryButton}
                      testID={MOBILE_E2E_IDS.accountVerificationCheckButton}
                      onPress={onRefreshAccount}
                    >
                      <Text style={styles.primaryLabel}>I verified my email</Text>
                    </Pressable>
                  </View>
                ) : auth.user.cloudAccess === "inactive" ? (
                  <View
                    style={styles.accountState}
                    testID={MOBILE_E2E_IDS.accountSubscriptionState}
                  >
                    <Text style={styles.accountStateTitle}>
                      {customRelayUrl
                        ? "Kanna Cloud subscription inactive"
                        : "Subscription required"}
                    </Text>
                    <Text style={styles.accountStateCopy}>
                      {customRelayUrl
                        ? "Hosted Kanna Cloud features need a subscription. Your custom relay can still connect without one."
                        : "Kanna Cloud features need an active subscription. Subscribe on the Kanna account portal."}
                    </Text>
                    <Pressable
                      accessibilityLabel="Subscribe to Kanna Cloud"
                      accessibilityRole="link"
                      style={styles.primaryButton}
                      testID={MOBILE_E2E_IDS.accountSubscribeLink}
                      onPress={() => void Linking.openURL(subscriptionUrl)}
                    >
                      <Text style={styles.primaryLabel}>View subscription</Text>
                    </Pressable>
                  </View>
                ) : auth.user.cloudAccess === "active" ? (
                  <View style={styles.accountState} testID={MOBILE_E2E_IDS.accountEntitledState}>
                    <Text style={styles.accountStateTitle}>Cloud access active</Text>
                    <Text style={styles.accountStateCopy}>
                      Your Kanna Cloud subscription is ready.
                    </Text>
                  </View>
                ) : (
                  <View style={styles.accountState}>
                    <Text style={styles.accountStateCopy}>Checking cloud subscription…</Text>
                  </View>
                )}
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
                    !canSubmit || auth.status === "signingIn" ? styles.primaryButtonDisabled : null
                  ]}
                  testID={MOBILE_E2E_IDS.accountSignInButton}
                  onPress={() => {
                    setSubmissionMode("signIn");
                    onSignIn(email.trim(), password);
                  }}
                >
                  <Text style={styles.primaryLabel}>
                    {auth.status === "signingIn" && submissionMode === "signIn"
                      ? "Signing In..."
                      : "Sign In"}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={!canCreate || auth.status === "signingIn"}
                  style={[
                    styles.secondaryButton,
                    !canCreate || auth.status === "signingIn" ? styles.primaryButtonDisabled : null
                  ]}
                  testID={MOBILE_E2E_IDS.accountCreateButton}
                  onPress={() => {
                    setSubmissionMode("create");
                    onCreateAccount(email.trim(), password);
                  }}
                >
                  <Text style={styles.secondaryLabel}>
                    {auth.status === "signingIn" && submissionMode === "create"
                      ? "Creating..."
                      : "Create account"}
                  </Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
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
              This immediately cancels your subscription and permanently deletes your cloud data and
              cloud desktop pairings. Local Kanna data and LAN pairings stay on your devices. This
              cannot be undone.
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
                    : null
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
    maxHeight: "92%"
  },
  sheetContent: {
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
    flex: 1,
    gap: 12
  },
  identityCopy: {
    flex: 1
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
    marginLeft: 12,
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
  accountState: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  accountStateTitle: {
    color: "#F5F7FB",
    fontSize: 16,
    fontWeight: "800"
  },
  accountStateCopy: {
    color: "#C3CEE0",
    fontSize: 13,
    lineHeight: 19
  },
  relayCard: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  relayHeadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  customRelayBadge: {
    backgroundColor: "#183E35",
    borderColor: "#2D7A65",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  defaultRelayBadge: {
    backgroundColor: "#172338",
    borderColor: "#2A3957",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  relayBadgeLabel: {
    color: "#D9E7F8",
    fontSize: 11,
    fontWeight: "800"
  },
  relayActions: {
    gap: 8
  },
  relayHelp: {
    color: "#8296B5",
    fontSize: 12,
    lineHeight: 17
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
