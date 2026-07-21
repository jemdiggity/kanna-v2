import { ActionSheetIOS, Alert, Platform } from "react-native";

export type TaskAction = "view-diff" | "advance-stage" | "close-task";

const TASK_ACTIONS: ReadonlyArray<{
  id: TaskAction;
  label: string;
  style?: "destructive";
}> = [
  { id: "view-diff", label: "View Diff" },
  { id: "advance-stage", label: "Advance Stage" },
  { id: "close-task", label: "Close Task", style: "destructive" }
];

const MENU_TITLE = "Task Actions";
const CANCEL_LABEL = "Cancel";

export function showTaskActionMenu(
  onSelect: (action: TaskAction) => void,
  onDismiss: () => void = () => undefined
): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [...TASK_ACTIONS.map((action) => action.label), CANCEL_LABEL],
        cancelButtonIndex: TASK_ACTIONS.length,
        destructiveButtonIndex: TASK_ACTIONS.findIndex(
          (action) => action.style === "destructive"
        )
      },
      (buttonIndex) => {
        const action = TASK_ACTIONS[buttonIndex];
        if (action) {
          onSelect(action.id);
        } else {
          onDismiss();
        }
      }
    );
    return;
  }

  Alert.alert(
    MENU_TITLE,
    undefined,
    [
      ...TASK_ACTIONS.map((action) => ({
        text: action.label,
        style: action.style,
        onPress: () => onSelect(action.id)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const, onPress: onDismiss }
    ],
    { cancelable: true, onDismiss }
  );
}
