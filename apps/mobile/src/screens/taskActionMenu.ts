import { ActionSheetIOS, Alert, Platform } from "react-native";
import type { TaskStageAction } from "../state/sessionStore";

export type TaskAction = "preview" | "browse-files" | "mentioned-files" | "view-diff" | TaskStageAction;

interface TaskActionDefinition {
  id: TaskAction;
  label: string;
  style?: "destructive";
}

export interface TaskActionMenuOptions {
  mentionedFilesLabel: string;
  taskCreation?: boolean;
  previewAvailable?: boolean;
}

const MENU_TITLE = "Task Actions";
const CANCEL_LABEL = "Cancel";

export function showTaskActionMenu(
  options: TaskActionMenuOptions,
  onSelect: (action: TaskAction) => void,
  onDismiss: () => void = () => undefined
): void {
  const allTaskActions: readonly TaskActionDefinition[] = [
    ...(options.previewAvailable
      ? [{ id: "preview" as const, label: "Preview Dev Server" }]
      : []),
    { id: "browse-files", label: "Browse Files" },
    { id: "mentioned-files", label: options.mentionedFilesLabel },
    { id: "view-diff", label: "View Diff" },
    { id: "advance-stage", label: "Advance Stage" },
    { id: "close-task", label: "Close Task", style: "destructive" }
  ];
  const taskActions = options.taskCreation
    ? allTaskActions.filter((action) => action.id === "close-task")
    : allTaskActions;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [...taskActions.map((action) => action.label), CANCEL_LABEL],
        cancelButtonIndex: taskActions.length,
        destructiveButtonIndex: taskActions.findIndex(
          (action) => action.style === "destructive"
        )
      },
      (buttonIndex) => {
        const action = taskActions[buttonIndex];
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
      ...taskActions.map((action) => ({
        text: action.label,
        style: action.style,
        onPress: () => onSelect(action.id)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const, onPress: onDismiss }
    ],
    { cancelable: true, onDismiss }
  );
}
