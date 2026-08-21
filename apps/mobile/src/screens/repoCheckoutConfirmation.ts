import { Alert } from "react-native";
import type { RepoCheckoutOffer } from "../state/sessionStore";

export function confirmRepoCheckout(
  offer: RepoCheckoutOffer,
  onConfirm: () => void
): void {
  Alert.alert(
    `Check out ${offer.repoName} on ${offer.desktopName}?`,
    `Kanna will clone the repository directly on ${offer.desktopName}. Private repositories require git credentials configured on that machine.`,
    [
      { style: "cancel", text: "Cancel" },
      { text: "Check Out", onPress: onConfirm }
    ]
  );
}
