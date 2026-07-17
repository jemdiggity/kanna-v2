import React from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { TaskSummary } from "../lib/api/types";
import { TaskList } from "../components/TaskList";
import { projectTaskUiSlots } from "../state/taskUiSlots";

interface SearchScreenProps {
  query: string;
  results: TaskSummary[];
  onChangeQuery(query: string): void;
  onOpenTask(taskId: string): void;
}

export function SearchScreen({
  query,
  results,
  onChangeQuery,
  onOpenTask
}: SearchScreenProps) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      testID={MOBILE_E2E_IDS.searchScreen}
    >
      <View style={styles.wrap}>
        <Text style={styles.heading}>Search</Text>
        <Text style={styles.subheading}>
          Search tasks by title or prompt content across the paired desktop.
        </Text>
        <TextInput
          autoCapitalize="none"
          onChangeText={onChangeQuery}
          placeholder="Search tasks"
          placeholderTextColor="#6A7E9D"
          style={styles.input}
          value={query}
        />
        <TaskList
          emptyLabel={
            query
              ? "No tasks matched that search yet."
              : "Start typing to search tasks across your desktop."
          }
          taskSlots={projectTaskUiSlots(results, [])}
          onOpenTask={onOpenTask}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 140
  },
  wrap: {
    gap: 14
  },
  heading: {
    color: "#F5F7FB",
    fontSize: 24,
    fontWeight: "700"
  },
  subheading: {
    color: "#A9B8D1",
    fontSize: 14,
    lineHeight: 20
  },
  input: {
    backgroundColor: "#10192A",
    borderColor: "#22304D",
    borderRadius: 18,
    borderWidth: 1,
    color: "#F5F7FB",
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14
  }
});
