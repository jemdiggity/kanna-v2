import { ActionSheetIOS, Alert, Platform } from "react-native";
import {
  TASK_QUICK_REPLIES,
  type TaskQuickReply
} from "./taskQuickReplies";

const MENU_TITLE = "Quick Replies";
const CANCEL_LABEL = "Cancel";

export function showTaskQuickReplyMenu(
  onSelect: (quickReply: TaskQuickReply) => void
): void {
  if (Platform.OS === "ios") {
    const cancelButtonIndex = TASK_QUICK_REPLIES.length;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [
          ...TASK_QUICK_REPLIES.map((quickReply) => quickReply.label),
          CANCEL_LABEL
        ],
        cancelButtonIndex
      },
      (buttonIndex) => {
        const quickReply = TASK_QUICK_REPLIES[buttonIndex];
        if (quickReply) {
          onSelect(quickReply);
        }
      }
    );
    return;
  }

  Alert.alert(
    MENU_TITLE,
    undefined,
    [
      ...TASK_QUICK_REPLIES.map((quickReply) => ({
        text: quickReply.label,
        onPress: () => onSelect(quickReply)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const }
    ]
  );
}
