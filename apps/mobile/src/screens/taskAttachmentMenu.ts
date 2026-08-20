import { ActionSheetIOS, Alert, Platform } from "react-native";
import type { ImageAttachmentSource } from "../lib/attachments/pickImageAttachment";

const MENU_TITLE = "Attach a Photo";
const CANCEL_LABEL = "Cancel";

interface AttachmentSourceDefinition {
  id: ImageAttachmentSource;
  label: string;
}

const ATTACHMENT_SOURCES: readonly AttachmentSourceDefinition[] = [
  { id: "library", label: "Photo Library" },
  { id: "camera", label: "Take Photo" }
];

/**
 * Ask which camera roll the photo comes from. Same shape as
 * `showTaskActionMenu` so both composer menus behave identically on each
 * platform.
 */
export function showImageAttachmentSourceMenu(
  onSelect: (source: ImageAttachmentSource) => void,
  onDismiss: () => void = () => undefined
): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [
          ...ATTACHMENT_SOURCES.map((source) => source.label),
          CANCEL_LABEL
        ],
        cancelButtonIndex: ATTACHMENT_SOURCES.length
      },
      (buttonIndex) => {
        const source = ATTACHMENT_SOURCES[buttonIndex];
        if (source) {
          onSelect(source.id);
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
      ...ATTACHMENT_SOURCES.map((source) => ({
        text: source.label,
        onPress: () => onSelect(source.id)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const, onPress: onDismiss }
    ],
    { cancelable: true, onDismiss }
  );
}
