import { ActionSheetIOS, Alert, Platform } from "react-native";
import type { TaskStageAction } from "../state/sessionStore";

export type TaskAction = "view-diff" | TaskStageAction;

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
  onDismiss: () => void = () => undefined,
  options: { taskCreation?: boolean } = {}
): void {
  const actions = options.taskCreation
    ? TASK_ACTIONS.filter((action) => action.id === "close-task")
    : TASK_ACTIONS;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [...actions.map((action) => action.label), CANCEL_LABEL],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex(
          (action) => action.style === "destructive"
        )
      },
      (buttonIndex) => {
        const action = actions[buttonIndex];
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
      ...actions.map((action) => ({
        text: action.label,
        style: action.style,
        onPress: () => onSelect(action.id)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const, onPress: onDismiss }
    ],
    { cancelable: true, onDismiss }
  );
}
