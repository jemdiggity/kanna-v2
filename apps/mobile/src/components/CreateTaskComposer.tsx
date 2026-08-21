import React from "react";
import { AGENT_PROVIDERS, type AgentProvider } from "@kanna/agent-protocol";
import {
  KeyboardAvoidingView,
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
import type { DesktopSummary, RepoSummary } from "../lib/api/types";
import {
  agentProviderOptionsForDesktop,
  desktopReportsNoAgentProvider
} from "../lib/api/agentProviders";
import type {
  ComposerAgentProvider,
  RepoCheckoutOffer
} from "../state/sessionStore";

interface CreateTaskComposerProps {
  isOpen: boolean;
  prompt: string;
  repos: RepoSummary[];
  desktops: DesktopSummary[];
  selectedRepoId: string | null;
  selectedDesktopId: string | null;
  selectedAgentProvider: ComposerAgentProvider | null;
  isOptionsExpanded: boolean;
  errorMessage: string | null;
  checkoutOffer?: RepoCheckoutOffer | null;
  onClose(): void;
  onSelectDesktop(desktopId: string): void;
  onSelectAgentProvider(provider: ComposerAgentProvider): void;
  onToggleOptions(): void;
  onChangePrompt(prompt: string): void;
  onSubmit(): void;
  onCheckout?(): void;
}

const AGENT_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  copilot: "Copilot",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity"
};

/** Named in the "nothing installed" explanation, so the advice cannot drift
 * away from the providers Kanna actually supports. */
const INSTALLABLE_AGENT_NAMES = AGENT_PROVIDERS
  .map((provider) => AGENT_LABELS[provider])
  .join(", ");

function agentOptionsForDesktop(desktop: DesktopSummary | null) {
  return agentProviderOptionsForDesktop(desktop).map((provider) => ({
    provider,
    label: AGENT_LABELS[provider]
  }));
}

export function CreateTaskComposer({
  isOpen,
  prompt,
  repos = [],
  desktops = [],
  selectedRepoId,
  selectedDesktopId,
  selectedAgentProvider = null,
  isOptionsExpanded = false,
  errorMessage = null,
  checkoutOffer = null,
  onClose,
  onSelectDesktop,
  onSelectAgentProvider,
  onToggleOptions,
  onChangePrompt,
  onSubmit,
  onCheckout
}: CreateTaskComposerProps) {
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;
  const selectedDesktop =
    desktops.find((desktop) => desktop.id === selectedDesktopId) ?? null;
  // Only the providers the selected machine can actually run. A machine that
  // reported no inventory (an older desktop) still offers everything Kanna
  // supports, which is the behaviour that shipped before inventory existed.
  const agentOptions = agentOptionsForDesktop(selectedDesktop);
  const machineHasNoAgent =
    selectedDesktop !== null && desktopReportsNoAgentProvider(selectedDesktop);
  const selectedAgentLabel =
    agentOptions.find((option) => option.provider === selectedAgentProvider)?.label ??
    (machineHasNoAgent ? "No agent installed" : "Choose agent");
  const canSubmit = Boolean(
    selectedRepoId &&
      selectedDesktop &&
      prompt.trim() &&
      !machineHasNoAgent &&
      !checkoutOffer
  );
  const selectedDesktopLabel = selectedDesktop
    ? `${selectedDesktop.name} (${selectedDesktop.online ? "online" : "offline"})`
    : "Choose machine";

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={isOpen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <Pressable
          accessibilityElementsHidden
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            testID={MOBILE_E2E_IDS.createTaskSheetScroll}
          >
            <Text style={styles.eyebrow}>New task</Text>
            <Text numberOfLines={1} style={styles.title}>
              {selectedRepo ? selectedRepo.name : "Choose a repo"}
            </Text>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: isOptionsExpanded }}
              style={styles.optionsSummary}
              testID={MOBILE_E2E_IDS.createTaskOptionsToggle}
              onPress={onToggleOptions}
            >
              <View>
                <Text style={styles.optionsTitle}>Options</Text>
                <Text style={styles.optionsValue} numberOfLines={1}>
                  {selectedDesktopLabel} · {selectedAgentLabel}
                </Text>
              </View>
              <Text style={styles.optionsChevron}>
                {isOptionsExpanded ? "Hide" : "Edit"}
              </Text>
            </Pressable>

            {isOptionsExpanded ? (
              <View style={styles.optionsPanel}>
                <View style={styles.optionSection}>
                  <Text style={styles.optionLabel}>Machine</Text>
                  <View style={styles.choiceGroup}>
                    {desktops.map((desktop) => {
                      const selected = desktop.id === selectedDesktop?.id;
                      return (
                        <Pressable
                          key={desktop.id}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          style={[
                            styles.choiceOption,
                            selected ? styles.choiceOptionSelected : null
                          ]}
                          testID={MOBILE_E2E_IDS.createTaskMachineOption(desktop.id)}
                          onPress={() => onSelectDesktop(desktop.id)}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.choiceOptionLabel,
                              selected ? styles.choiceOptionLabelSelected : null
                            ]}
                          >
                            {desktop.name}
                          </Text>
                          <Text
                            style={[
                              styles.choiceOptionMeta,
                              selected ? styles.choiceOptionMetaSelected : null
                            ]}
                          >
                            {desktop.online ? "Online" : "Offline"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.optionSection}>
                  <Text style={styles.optionLabel}>Agent</Text>
                  {machineHasNoAgent ? (
                    <Text style={styles.helperText}>
                      {selectedDesktop?.name} has no agent CLI installed. Install
                      one of {INSTALLABLE_AGENT_NAMES} on that machine to create
                      tasks there.
                    </Text>
                  ) : null}
                  <View style={styles.choiceGroup}>
                    {agentOptions.map((option) => {
                      const selected = option.provider === selectedAgentProvider;
                      return (
                        <Pressable
                          key={option.provider}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          style={[
                            styles.choiceOption,
                            selected ? styles.choiceOptionSelected : null
                          ]}
                          testID={MOBILE_E2E_IDS.createTaskAgentOption(option.provider)}
                          onPress={() => onSelectAgentProvider(option.provider)}
                        >
                          <Text
                            style={[
                              styles.choiceOptionLabel,
                              selected ? styles.choiceOptionLabelSelected : null
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
            ) : null}

            {!selectedDesktop && !errorMessage ? (
              <Text style={styles.helperText}>Choose a machine before creating.</Text>
            ) : null}

            <TextInput
              multiline
              onChangeText={onChangePrompt}
              placeholder="Describe the task"
              placeholderTextColor="#6A7E9D"
              style={styles.input}
              testID={MOBILE_E2E_IDS.createTaskPromptInput}
              value={prompt}
            />

            {errorMessage ? (
              <Text style={styles.errorText} testID={MOBILE_E2E_IDS.createTaskError}>
                {errorMessage}
              </Text>
            ) : null}

            {checkoutOffer && onCheckout ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: checkoutOffer.status === "running" }}
                disabled={checkoutOffer.status === "running"}
                onPress={onCheckout}
                style={styles.checkoutButton}
                testID={MOBILE_E2E_IDS.createTaskCheckoutButton}
              >
                <Text style={styles.checkoutLabel}>
                  {checkoutOffer.status === "running"
                    ? `Checking out on ${checkoutOffer.desktopName}…`
                    : `Check out on ${checkoutOffer.desktopName}`}
                </Text>
              </Pressable>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                style={styles.secondaryButton}
                testID={MOBILE_E2E_IDS.createTaskCancelButton}
                onPress={onClose}
              >
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
                disabled={!canSubmit}
                style={[styles.primaryButton, !canSubmit ? styles.primaryButtonDisabled : null]}
                testID={MOBILE_E2E_IDS.createTaskSubmitButton}
                onPress={canSubmit ? onSubmit : undefined}
              >
                <Text style={styles.primaryLabel}>
                  Create
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: "rgba(1, 5, 12, 0.58)",
    flex: 1,
    justifyContent: "flex-end"
  },
  sheet: {
    backgroundColor: "#0E1728",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    elevation: 1,
    flexShrink: 1,
    maxHeight: "100%",
    zIndex: 1
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 36,
    paddingHorizontal: 20,
    paddingTop: 18
  },
  eyebrow: {
    color: "#A9B8D1",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  title: {
    color: "#F5F7FB",
    fontSize: 22,
    fontWeight: "700"
  },
  optionsSummary: {
    alignItems: "center",
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  optionsTitle: {
    color: "#F5F7FB",
    fontSize: 13,
    fontWeight: "800"
  },
  optionsValue: {
    color: "#A9B8D1",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 3
  },
  optionsChevron: {
    color: "#CBE1FF",
    fontSize: 13,
    fontWeight: "800"
  },
  optionsPanel: {
    gap: 12
  },
  optionSection: {
    gap: 8
  },
  optionLabel: {
    color: "#A9B8D1",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  choiceGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  choiceOption: {
    backgroundColor: "#152036",
    borderColor: "#22304D",
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: "100%",
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  choiceOptionSelected: {
    backgroundColor: "#E8F1FF",
    borderColor: "#E8F1FF"
  },
  choiceOptionLabel: {
    color: "#D5DEEC",
    fontSize: 12,
    fontWeight: "800"
  },
  choiceOptionLabelSelected: {
    color: "#0B1220"
  },
  choiceOptionMeta: {
    color: "#93A7C8",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2
  },
  choiceOptionMetaSelected: {
    color: "#30405D"
  },
  helperText: {
    color: "#A9B8D1",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18
  },
  input: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 18,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    minHeight: 150,
    padding: 16,
    textAlignVertical: "top"
  },
  actions: {
    flexDirection: "row",
    gap: 10
  },
  secondaryButton: {
    backgroundColor: "#152036",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 14
  },
  primaryButton: {
    backgroundColor: "#E8F1FF",
    borderRadius: 16,
    flex: 1,
    paddingVertical: 14
  },
  primaryButtonDisabled: {
    opacity: 0.48
  },
  errorText: {
    color: "#FFB4A8",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18
  },
  checkoutButton: {
    backgroundColor: "#244D7C",
    borderRadius: 14,
    paddingVertical: 12
  },
  checkoutLabel: {
    color: "#E8F1FF",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center"
  },
  secondaryLabel: {
    color: "#D5DEEC",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center"
  },
  primaryLabel: {
    color: "#0B1220",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center"
  }
});
