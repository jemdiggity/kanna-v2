import type { SessionPersistence } from "./state/sessionPersistence";

interface LinkingLike {
  addEventListener(
    eventName: "url",
    listener: (event: { url: string }) => void
  ): { remove(): void };
  getInitialURL(): Promise<string | null>;
}

interface ReactNativeModule {
  Linking: LinkingLike;
}

declare const require: ((id: string) => ReactNativeModule) | undefined;

export function installE2eTrustSeedHandler(input: {
  getPersistence(): Promise<SessionPersistence>;
  reload(): Promise<void>;
}): () => void {
  const linking = loadLinking();
  if (!linking) {
    return () => undefined;
  }

  const handleUrl = (url: string) => {
    void seedTrustedDesktopFromUrl(url, input);
  };
  const subscription = linking.addEventListener("url", (event) => handleUrl(event.url));
  void linking.getInitialURL().then((url) => {
    if (url) {
      handleUrl(url);
    }
  });
  return () => subscription.remove();
}

export async function seedTrustedDesktopFromUrl(
  url: string,
  input: {
    getPersistence(): Promise<SessionPersistence>;
    reload(): Promise<void>;
  }
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "kanna:" || parsed.hostname !== "e2e-trust") {
    return;
  }
  const desktopId = parsed.searchParams.get("desktopId");
  const displayName = parsed.searchParams.get("displayName");
  if (!desktopId || !displayName) {
    return;
  }

  const persistence = await input.getPersistence();
  const seededAt = new Date().toISOString();
  const lanBaseUrl = parsed.searchParams.get("lanBaseUrl")?.trim() || null;
  await persistence.save({
    mobileDeviceId: null,
    selectedDesktopId: desktopId,
    selectedRepoId: parsed.searchParams.get("selectedRepoId")?.trim() || null,
    selectedTaskId: parsed.searchParams.get("selectedTaskId")?.trim() || null,
    activeView: "tasks",
    trustedDesktops: [
      {
        desktopId,
        displayName,
        lanEndpoints: lanBaseUrl
          ? [{ baseUrl: lanBaseUrl, lastSeenAt: seededAt }]
          : [],
        lastSeenAt: seededAt
      }
    ]
  });
  await input.reload();
}

function loadLinking(): LinkingLike | null {
  try {
    return typeof require === "function" ? require("react-native").Linking : null;
  } catch {
    return null;
  }
}
