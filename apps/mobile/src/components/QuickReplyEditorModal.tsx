import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
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
import {
  addTaskQuickReply,
  deleteTaskQuickReply,
  MAX_TASK_QUICK_REPLIES,
  moveTaskQuickReply,
  normalizeTaskQuickReplies,
  type TaskQuickReply,
  updateTaskQuickReply,
  validateTaskQuickReplies
} from "../screens/taskQuickReplies";

interface QuickReplyEditorModalProps {
  replies: readonly TaskQuickReply[];
  replacementConfirmationRequired?: boolean;
  visible: boolean;
  onClose(): void;
  onSave(
    replies: readonly TaskQuickReply[],
    confirmReplacement?: boolean
  ): Promise<void>;
}

let generatedReplySequence = 0;

export function QuickReplyEditorModal({
  replies,
  replacementConfirmationRequired = false,
  visible,
  onClose,
  onSave
}: QuickReplyEditorModalProps) {
  const wasVisibleRef = useRef(false);
  const inputRefs = useRef(new Map<string, TextInput>());
  const [draftReplies, setDraftReplies] = useState<TaskQuickReply[]>(() =>
    copyReplies(replies)
  );
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setDraftReplies(copyReplies(replies));
      setErrors({});
      setListError(null);
      setSaveError(null);
      setSaving(false);
    }
    wasVisibleRef.current = visible;
  }, [replies, visible]);

  const clearValidation = () => {
    setErrors({});
    setListError(null);
    setSaveError(null);
  };

  const updateReply = (replyId: string, text: string) => {
    clearValidation();
    setDraftReplies((current) => [
      ...updateTaskQuickReply(current, replyId, text)
    ]);
  };

  const addReply = () => {
    if (draftReplies.length >= MAX_TASK_QUICK_REPLIES || saving) {
      return;
    }
    clearValidation();
    setDraftReplies((current) => [
      ...addTaskQuickReply(current, {
        id: createTaskQuickReplyId(),
        text: ""
      })
    ]);
  };

  const moveReply = (replyId: string, direction: -1 | 1) => {
    clearValidation();
    setDraftReplies((current) => [
      ...moveTaskQuickReply(current, replyId, direction)
    ]);
  };

  const deleteReply = (replyId: string) => {
    clearValidation();
    setDraftReplies((current) => [
      ...deleteTaskQuickReply(current, replyId)
    ]);
  };

  const save = async () => {
    if (saving) {
      return;
    }
    const validation = validateTaskQuickReplies(draftReplies);
    setErrors(validation.errors);
    setListError(validation.listError);
    setSaveError(null);
    if (!validation.valid) {
      const firstInvalidIndex = Object.keys(validation.errors)
        .map(Number)
        .sort((left, right) => left - right)[0];
      const firstInvalidReply =
        firstInvalidIndex === undefined
          ? undefined
          : draftReplies[firstInvalidIndex];
      if (firstInvalidReply) {
        inputRefs.current.get(firstInvalidReply.id)?.focus();
      }
      return;
    }

    const normalized = normalizeTaskQuickReplies(draftReplies);
    const confirmReplacement = replacementConfirmationRequired
      ? await confirmQuickReplyReplacement()
      : false;
    if (replacementConfirmationRequired && !confirmReplacement) {
      return;
    }
    setSaving(true);
    try {
      await onSave(normalized, confirmReplacement);
      onClose();
    } catch {
      setSaveError("Could not save quick replies. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View style={styles.scrim} />
        <View style={styles.sheet} testID={MOBILE_E2E_IDS.quickReplyEditor}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Quick Replies</Text>
              <Text style={styles.subtitle}>
                The first reply sits closest to Send.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={() => void save()}
              style={[styles.doneButton, saving ? styles.disabled : null]}
              testID={MOBILE_E2E_IDS.quickReplyEditorDone}
            >
              <Text style={styles.doneLabel}>{saving ? "Saving…" : "Done"}</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
          >
            {draftReplies.map((reply, index) => (
              <View key={reply.id} style={styles.replyRow}>
                <View style={styles.orderControls}>
                  <Pressable
                    accessibilityLabel={`Move ${reply.text || "quick reply"} up`}
                    accessibilityRole="button"
                    disabled={index === 0 || saving}
                    onPress={() => moveReply(reply.id, -1)}
                    style={[
                      styles.orderButton,
                      index === 0 || saving ? styles.disabled : null
                    ]}
                    testID={MOBILE_E2E_IDS.quickReplyEditorMoveUp(reply.id)}
                  >
                    <Text style={styles.orderLabel}>↑</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Move ${reply.text || "quick reply"} down`}
                    accessibilityRole="button"
                    disabled={index === draftReplies.length - 1 || saving}
                    onPress={() => moveReply(reply.id, 1)}
                    style={[
                      styles.orderButton,
                      index === draftReplies.length - 1 || saving
                        ? styles.disabled
                        : null
                    ]}
                    testID={MOBILE_E2E_IDS.quickReplyEditorMoveDown(reply.id)}
                  >
                    <Text style={styles.orderLabel}>↓</Text>
                  </Pressable>
                </View>
                <View style={styles.inputGroup}>
                  <TextInput
                    multiline
                    onChangeText={(text) => updateReply(reply.id, text)}
                    placeholder="Quick reply"
                    placeholderTextColor="#6A7E9D"
                    ref={(input) => {
                      if (input) {
                        inputRefs.current.set(reply.id, input);
                      } else {
                        inputRefs.current.delete(reply.id);
                      }
                    }}
                    style={[
                      styles.input,
                      errors[index] ? styles.inputError : null
                    ]}
                    testID={MOBILE_E2E_IDS.quickReplyEditorInput(reply.id)}
                    value={reply.text}
                  />
                  {errors[index] ? (
                    <Text
                      style={styles.errorText}
                      testID={MOBILE_E2E_IDS.quickReplyEditorError(reply.id)}
                    >
                      {errors[index]}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityLabel={`Delete ${reply.text || "quick reply"}`}
                  accessibilityRole="button"
                  disabled={draftReplies.length === 1 || saving}
                  onPress={() => deleteReply(reply.id)}
                  style={[
                    styles.deleteButton,
                    draftReplies.length === 1 || saving ? styles.disabled : null
                  ]}
                  testID={MOBILE_E2E_IDS.quickReplyEditorDelete(reply.id)}
                >
                  <Text style={styles.deleteLabel}>−</Text>
                </Pressable>
              </View>
            ))}

            {listError ? <Text style={styles.errorText}>{listError}</Text> : null}
            {saveError ? (
              <Text
                style={styles.errorText}
                testID={MOBILE_E2E_IDS.quickReplyEditorSaveError}
              >
                {saveError}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={
                draftReplies.length >= MAX_TASK_QUICK_REPLIES || saving
              }
              onPress={addReply}
              style={[
                styles.addButton,
                draftReplies.length >= MAX_TASK_QUICK_REPLIES || saving
                  ? styles.disabled
                  : null
              ]}
              testID={MOBILE_E2E_IDS.quickReplyEditorAdd}
            >
              <Text style={styles.addLabel}>＋ Add quick reply</Text>
            </Pressable>
            <Text style={styles.countLabel}>
              {`${draftReplies.length} of ${MAX_TASK_QUICK_REPLIES} replies`}
            </Text>
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={onClose}
            style={[styles.cancelButton, saving ? styles.disabled : null]}
            testID={MOBILE_E2E_IDS.quickReplyEditorCancel}
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function confirmQuickReplyReplacement(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Replace quick replies?",
      "Your saved quick replies could not be loaded. Continuing will replace the active stored copy with the defaults and edits shown here.",
      [
        {
          style: "cancel",
          text: "Cancel",
          onPress: () => resolve(false)
        },
        {
          style: "destructive",
          text: "Replace",
          onPress: () => resolve(true)
        }
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

function copyReplies(replies: readonly TaskQuickReply[]): TaskQuickReply[] {
  return replies.map((reply) => ({ ...reply }));
}

function createTaskQuickReplyId(): string {
  generatedReplySequence += 1;
  return `custom-${Date.now().toString(36)}-${generatedReplySequence.toString(36)}`;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    backgroundColor: "rgba(2, 6, 14, 0.72)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  },
  sheet: {
    backgroundColor: "#0D1727",
    borderColor: "#2B4265",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    maxHeight: "88%",
    padding: 18,
    paddingBottom: 34
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    marginBottom: 14
  },
  headerCopy: { flex: 1 },
  title: { color: "#F5F7FB", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#8FA5C3", fontSize: 12, marginTop: 4 },
  doneButton: {
    backgroundColor: "#245A9F",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  doneLabel: { color: "#E9F3FF", fontSize: 13, fontWeight: "800" },
  list: { gap: 10, paddingBottom: 8 },
  replyRow: {
    alignItems: "flex-start",
    backgroundColor: "#101C2F",
    borderColor: "#263B5C",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 10
  },
  orderControls: { gap: 4 },
  orderButton: {
    alignItems: "center",
    backgroundColor: "#172A44",
    borderRadius: 8,
    height: 28,
    justifyContent: "center",
    width: 28
  },
  orderLabel: { color: "#9FC6F3", fontSize: 15, fontWeight: "800" },
  inputGroup: { flex: 1 },
  input: {
    color: "#F5F7FB",
    fontSize: 14,
    lineHeight: 19,
    minHeight: 58,
    padding: 7,
    textAlignVertical: "top"
  },
  inputError: { borderColor: "#D2606C", borderWidth: 1, borderRadius: 10 },
  deleteButton: {
    alignItems: "center",
    backgroundColor: "#43232D",
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28
  },
  deleteLabel: { color: "#FFB1B9", fontSize: 18, fontWeight: "800" },
  errorText: { color: "#FF9AA5", fontSize: 12, lineHeight: 17, marginTop: 3 },
  addButton: {
    alignItems: "center",
    borderColor: "#42628D",
    borderRadius: 15,
    borderStyle: "dashed",
    borderWidth: 1,
    padding: 13
  },
  addLabel: { color: "#9EC8F7", fontSize: 13, fontWeight: "800" },
  countLabel: { color: "#6F86A6", fontSize: 11, textAlign: "center" },
  cancelButton: { alignItems: "center", padding: 12 },
  cancelLabel: { color: "#A7B9D1", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.4 }
});
