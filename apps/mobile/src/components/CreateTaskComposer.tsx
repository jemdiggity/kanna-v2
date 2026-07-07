import React from "react";
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
import type { DesktopSummary, RepoSummary } from "../lib/api/types";
import type { ComposerAgentProvider } from "../state/sessionStore";

interface CreateTaskComposerProps {
  isOpen: boolean;
  prompt: string;
  repos: RepoSummary[];
  desktops: DesktopSummary[];
  selectedRepoId: string | null;
  selectedDesktopId: string | null;
  selectedAgentProvider: ComposerAgentProvider;
  isOptionsExpanded: boolean;
  errorMessage: string | null;
  isSubmitting: boolean;
  onClose(): void;
  onSelectDesktop(desktopId: string): void;
  onSelectAgentProvider(provider: ComposerAgentProvider): void;
  onToggleOptions(): void;
  onChangePrompt(prompt: string): void;
  onSubmit(): void;
}

const AGENT_OPTIONS: Array<{ provider: ComposerAgentProvider; label: string }> = [
  { provider: "claude", label: "Claude" },
  { provider: "copilot", label: "Copilot" },
  { provider: "codex", label: "Codex" },
  { provider: "opencode", label: "OpenCode" },
  { provider: "antigravity", label: "Antigravity" }
];

export function CreateTaskComposer({
  isOpen,
  prompt,
  repos = [],
  desktops = [],
  selectedRepoId,
  selectedDesktopId,
  selectedAgentProvider = "claude",
  isOptionsExpanded = false,
  errorMessage = null,
  isSubmitting = false,
  onClose,
  onSelectDesktop,
  onSelectAgentProvider,
  onToggleOptions,
  onChangePrompt,
  onSubmit
}: CreateTaskComposerProps) {
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null;
  const selectedDesktop =
    desktops.find((desktop) => desktop.id === selectedDesktopId) ?? null;
  const selectedAgentLabel =
    AGENT_OPTIONS.find((option) => option.provider === selectedAgentProvider)?.label ??
    selectedAgentProvider;
  const canSubmit =
    Boolean(selectedRepoId && selectedDesktop && prompt.trim()) && !isSubmitting;
  const selectedDesktopLabel = selectedDesktop
    ? `${selectedDesktop.name} (${selectedDesktop.online ? "online" : "offline"})`
    : "Choose machine";

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={isOpen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <Text style={styles.eyebrow}>New task</Text>
          <Text numberOfLines={1} style={styles.title}>
            {selectedRepo ? selectedRepo.name : "Choose a repo"}
          </Text>

          <Pressable
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
                <View style={styles.choiceGroup}>
                  {AGENT_OPTIONS.map((option) => {
                    const selected = option.provider === selectedAgentProvider;
                    return (
                      <Pressable
                        key={option.provider}
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

          <View style={styles.actions}>
            <Pressable style={styles.secondaryButton} onPress={onClose}>
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={!canSubmit}
              style={[styles.primaryButton, !canSubmit ? styles.primaryButtonDisabled : null]}
              testID={MOBILE_E2E_IDS.createTaskSubmitButton}
              onPress={canSubmit ? onSubmit : undefined}
            >
              <Text style={styles.primaryLabel}>
                {isSubmitting ? "Creating..." : "Create"}
              </Text>
            </Pressable>
          </View>
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
    gap: 14,
    paddingBottom: 36,
    paddingHorizontal: 20,
    paddingTop: 18,
    zIndex: 1
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
