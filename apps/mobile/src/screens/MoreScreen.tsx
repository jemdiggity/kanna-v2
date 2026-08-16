import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { BuildInfoPanel } from "../components/BuildInfoPanel";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { RepoCommandCatalog, RepoSummary } from "../lib/api/types";
import type { RepoCommandStatus } from "../state/sessionStore";
import { buildRepoCommandSections } from "./repoCommandPresentation";

interface MoreScreenProps {
  repos: RepoSummary[];
  selectedRepoId: string | null;
  catalog: RepoCommandCatalog | null;
  status: RepoCommandStatus;
  errorMessage: string | null;
  runningCommandId: string | null;
  scrollViewRef?: React.RefObject<ScrollView | null>;
  onSelectRepo(repoId: string): void;
  onRunCommand(commandId: string): void;
  onRetry(): void;
}

export function MoreScreen({
  repos,
  selectedRepoId,
  catalog,
  status,
  errorMessage,
  runningCommandId,
  scrollViewRef,
  onSelectRepo,
  onRunCommand,
  onRetry
}: MoreScreenProps) {
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => buildRepoCommandSections(catalog, query),
    [catalog, query]
  );

  return (
    <ScrollView
      ref={scrollViewRef}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      testID={MOBILE_E2E_IDS.moreScreen}
    >
      <View style={styles.wrap}>
        <Text style={styles.heading} testID={MOBILE_E2E_IDS.moreHeading}>
          More
        </Text>
        <Text style={styles.subheading}>Run a command for a repository.</Text>

        <ScrollView
          contentContainerStyle={styles.repoRow}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {repos.map((repo) => {
            const selected = repo.id === selectedRepoId;
            return (
              <Pressable
                disabled={runningCommandId !== null}
                key={repo.id}
                onPress={() => {
                  if (runningCommandId === null) {
                    onSelectRepo(repo.id);
                  }
                }}
                style={({ pressed }) => [
                  styles.repoChip,
                  selected ? styles.repoChipSelected : null,
                  runningCommandId !== null
                    ? styles.commandDisabled
                    : pressed
                      ? styles.commandPressed
                      : null
                ]}
                testID={MOBILE_E2E_IDS.moreRepo(repo.id)}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.repoLabel,
                    selected ? styles.repoLabelSelected : null
                  ]}
                >
                  {repo.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <TextInput
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder="Search repository commands"
          placeholderTextColor="#6A7E9D"
          style={styles.searchInput}
          testID={MOBILE_E2E_IDS.moreSearchInput}
          value={query}
        />

        {!selectedRepoId ? (
          <EmptyState
            title="Select a repository"
            copy="Choose a repository to see its commands."
          />
        ) : status === "loading" ? (
          <View style={styles.statusCard}>
            <ActivityIndicator color="#8CB8EF" />
            <Text style={styles.statusCopy}>Loading repository commands…</Text>
          </View>
        ) : status === "error" ? (
          <View style={styles.statusCard}>
            <Text style={styles.emptyTitle}>Commands unavailable</Text>
            <Text style={styles.emptyCopy}>
              {errorMessage ?? "Could not load commands."}
            </Text>
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [
                styles.retryButton,
                pressed ? styles.commandPressed : null
              ]}
              testID={MOBILE_E2E_IDS.moreRetryButton}
            >
              <Text style={styles.retryLabel}>Try Again</Text>
            </Pressable>
          </View>
        ) : sections.length === 0 ? (
          <EmptyState
            title={query.trim() ? "No commands matched" : "No repository commands"}
            copy={
              query.trim()
                ? "Try a different search."
                : "This repository has no available commands."
            }
          />
        ) : (
          sections.map((section) => (
            <View
              key={section.group}
              style={styles.section}
              testID={MOBILE_E2E_IDS.moreCommandGroup(section.group)}
            >
              <Text style={styles.sectionLabel}>{section.title}</Text>
              <View style={styles.commandList}>
                {section.commands.map((command) => {
                  const running = runningCommandId === command.id;
                  return (
                    <Pressable
                      disabled={runningCommandId !== null}
                      key={command.id}
                      onPress={() => onRunCommand(command.id)}
                      style={({ pressed }) => [
                        styles.command,
                        runningCommandId !== null
                          ? styles.commandDisabled
                          : pressed
                            ? styles.commandPressed
                            : null
                      ]}
                      testID={MOBILE_E2E_IDS.moreCommand(command.id)}
                    >
                      <View style={styles.commandText}>
                        <Text style={styles.commandTitle}>
                          {running ? "Running…" : command.label}
                        </Text>
                        <Text style={styles.commandCopy}>
                          {command.description}
                        </Text>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}

        <BuildInfoPanel />
      </View>
    </ScrollView>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <View style={styles.statusCard}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{copy}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 140 },
  wrap: { gap: 14 },
  heading: { color: "#F5F7FB", fontSize: 24, fontWeight: "700" },
  subheading: { color: "#93A7C8", fontSize: 14, marginTop: -8 },
  repoRow: { gap: 8, paddingRight: 12 },
  repoChip: {
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 220,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  repoChipSelected: { backgroundColor: "#17345A", borderColor: "#4C82C7" },
  repoLabel: { color: "#9EADC3", fontSize: 13, fontWeight: "700" },
  repoLabelSelected: { color: "#EAF3FF" },
  searchInput: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 13
  },
  section: { gap: 8 },
  sectionLabel: {
    color: "#7FA7D9",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase"
  },
  commandList: { gap: 8 },
  command: {
    alignItems: "center",
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 15
  },
  commandDisabled: { opacity: 0.62 },
  commandPressed: {
    backgroundColor: "#182842",
    borderColor: "#3A5F91",
    opacity: 0.82,
    transform: [{ scale: 0.98 }]
  },
  commandText: { flex: 1, gap: 4 },
  commandTitle: { color: "#F5F7FB", fontSize: 16, fontWeight: "700" },
  commandCopy: { color: "#A8B7CC", fontSize: 13, lineHeight: 18 },
  chevron: { color: "#6883A8", fontSize: 25, fontWeight: "300" },
  statusCard: {
    alignItems: "center",
    backgroundColor: "#0D1727",
    borderColor: "#22304D",
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 22
  },
  statusCopy: { color: "#A8B7CC", fontSize: 14 },
  emptyTitle: { color: "#F5F7FB", fontSize: 15, fontWeight: "700" },
  emptyCopy: {
    color: "#93A7C8",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center"
  },
  retryButton: {
    backgroundColor: "#275C96",
    borderRadius: 12,
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  retryLabel: { color: "#F5F7FB", fontSize: 14, fontWeight: "700" }
});
