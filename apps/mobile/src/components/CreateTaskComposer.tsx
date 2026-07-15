import React from "react";
import { AGENT_PROVIDERS, type AgentProvider } from "@kanna/agent-protocol";
import {
  ActivityIndicator,
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
import type {
  ComposerAgentProvider,
  TaskCreationPhase
} from "../state/sessionStore";

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
  taskCreationPhase: TaskCreationPhase;
  onClose(): void;
  onContinueInBackground(): void;
  onRecover(): void;
  onSelectDesktop(desktopId: string): void;
  onSelectAgentProvider(provider: ComposerAgentProvider): void;
  onToggleOptions(): void;
  onChangePrompt(prompt: string): void;
  onSubmit(): void;
}

const AGENT_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  copilot: "Copilot",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity"
};

const AGENT_OPTIONS = AGENT_PROVIDERS.map((provider) => ({
  provider,
  label: AGENT_LABELS[provider]
}));

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
  taskCreationPhase = "idle",
  onClose,
  onContinueInBackground,
  onRecover,
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
    Boolean(selectedRepoId && selectedDesktop && prompt.trim());
  const selectedDesktopLabel = selectedDesktop
    ? `${selectedDesktop.name} (${selectedDesktop.online ? "online" : "offline"})`
    : "Choose machine";

  if (taskCreationPhase !== "idle") {
    const provisioningRepoLabel = selectedRepo?.name ?? "Selected repo";
    const provisioningDesktopLabel = selectedDesktop?.name ?? "Selected machine";
    const provisioningRoute =
      `${provisioningRepoLabel} → ${provisioningDesktopLabel} · ${selectedAgentLabel}`;
    const isRecovering = taskCreationPhase === "recovering";
    const isBusy = taskCreationPhase !== "uncertain";
    const provisioningTitle = taskCreationPhase === "uncertain"
      ? "Task result unknown"
      : isRecovering
        ? "Recovering task"
        : "Provisioning task";
    const provisioningEyebrow = taskCreationPhase === "uncertain"
      ? "Response lost"
      : isRecovering
        ? "Identity replay"
        : "Workspace boot";
    const provisioningStatusCopy = taskCreationPhase === "uncertain"
      ? "The desktop may already have created this task. Recover checks the same task identity."
      : isRecovering
        ? "Checking the desktop with the same task identity…"
        : `Creating worktree and starting ${selectedAgentLabel}…`;
    const accessibilityLabel = taskCreationPhase === "uncertain"
      ? `Task result unknown for ${provisioningRepoLabel} on ${provisioningDesktopLabel}` +
        (errorMessage ? `. ${errorMessage}` : "")
      : `${isRecovering ? "Recovering" : "Provisioning"} task for ` +
        `${provisioningRepoLabel} on ${provisioningDesktopLabel} with ${selectedAgentLabel}`;

    return (
      <Modal
        animationType="slide"
        onRequestClose={onContinueInBackground}
        transparent
        visible={isOpen}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.overlay}
        >
          <Pressable
            accessibilityElementsHidden
            accessible={false}
            disabled
            importantForAccessibility="no-hide-descendants"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.sheet}>
            <View
              accessible
              accessibilityLabel={
                accessibilityLabel
              }
              accessibilityLiveRegion="polite"
              accessibilityRole={isBusy ? "progressbar" : "alert"}
              accessibilityState={{ busy: isBusy }}
              style={styles.provisioning}
              testID={MOBILE_E2E_IDS.createTaskProvisioning}
            >
              <View style={styles.provisioningHeader}>
                <View
                  accessibilityElementsHidden
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
                  style={styles.terminalTile}
                >
                  <Text style={styles.terminalPrompt}>
                    {taskCreationPhase === "uncertain" ? "?_" : ">_"}
                  </Text>
                  {isBusy ? (
                    <ActivityIndicator
                      color="#8FC5FF"
                      size="small"
                      style={styles.provisioningIndicator}
                    />
                  ) : null}
                </View>
                <View style={styles.provisioningHeading}>
                  <Text style={styles.provisioningEyebrow}>
                    {provisioningEyebrow}
                  </Text>
                  <Text style={styles.provisioningTitle}>{provisioningTitle}</Text>
                </View>
              </View>

              <View style={styles.provisioningRouteCard}>
                <Text numberOfLines={2} style={styles.provisioningRoute}>
                  {provisioningRoute}
                </Text>
              </View>

              <View style={styles.provisioningStatus}>
                <Text style={styles.provisioningStatusPrompt}>{"›"}</Text>
                <Text style={styles.provisioningStatusCopy}>
                  {provisioningStatusCopy}
                </Text>
              </View>
            </View>

            {taskCreationPhase === "uncertain" && errorMessage ? (
              <Text style={styles.errorText}>{errorMessage}</Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                style={styles.secondaryButton}
                testID={MOBILE_E2E_IDS.createTaskProvisioningBackground}
                onPress={onContinueInBackground}
              >
                <Text style={styles.secondaryLabel}>Continue in background</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isRecovering}
                style={[
                  styles.primaryButton,
                  isRecovering ? styles.primaryButtonDisabled : null
                ]}
                testID={MOBILE_E2E_IDS.createTaskProvisioningRecover}
                onPress={isRecovering ? undefined : onRecover}
              >
                <Text style={styles.primaryLabel}>
                  {isRecovering ? "Recovering…" : "Recover task"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

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
                Create
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
  provisioning: {
    gap: 20,
    paddingBottom: 8,
    paddingTop: 6
  },
  provisioningHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14
  },
  terminalTile: {
    alignItems: "center",
    backgroundColor: "#09111F",
    borderColor: "#2A4268",
    borderRadius: 16,
    borderWidth: 1,
    height: 64,
    justifyContent: "center",
    width: 64
  },
  terminalPrompt: {
    color: "#CBE1FF",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 18,
    fontWeight: "700"
  },
  provisioningIndicator: {
    bottom: 6,
    position: "absolute",
    right: 6,
    transform: [{ scale: 0.72 }]
  },
  provisioningHeading: {
    flex: 1,
    gap: 4
  },
  provisioningEyebrow: {
    color: "#8FC5FF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase"
  },
  provisioningTitle: {
    color: "#F5F7FB",
    fontSize: 22,
    fontWeight: "700"
  },
  provisioningRouteCard: {
    backgroundColor: "#101B2D",
    borderColor: "#263A5B",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  provisioningRoute: {
    color: "#BFD2EF",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 18
  },
  provisioningStatus: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 8
  },
  provisioningStatusPrompt: {
    color: "#8FC5FF",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 20
  },
  provisioningStatusCopy: {
    color: "#A9B8D1",
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 20
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
