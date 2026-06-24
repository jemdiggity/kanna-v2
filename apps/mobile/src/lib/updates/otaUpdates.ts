export type OtaUpdateCheckState = "up-to-date" | "downloaded" | "error";

export interface OtaUpdateCheckResult {
  state: OtaUpdateCheckState;
  error?: unknown;
}

export interface CurrentUpdateInfo {
  enabled: boolean;
  updateId: string | null;
  runtimeVersion: string | null;
  channel: string | null;
}

export interface ExpoUpdatesApi {
  isEnabled: boolean;
  updateId: string | null;
  runtimeVersion: string | null;
  channel: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean }>;
  reloadAsync(): Promise<void>;
}

export async function checkAndFetchUpdate(
  updates: ExpoUpdatesApi = getDefaultUpdatesApi()
): Promise<OtaUpdateCheckResult> {
  if (!updates.isEnabled) {
    return { state: "up-to-date" };
  }

  try {
    const checkResult = await updates.checkForUpdateAsync();
    if (!checkResult.isAvailable) {
      return { state: "up-to-date" };
    }

    const fetchResult = await updates.fetchUpdateAsync();
    return { state: fetchResult.isNew ? "downloaded" : "up-to-date" };
  } catch (error: unknown) {
    return { state: "error", error };
  }
}

export async function reloadToApplyUpdate(
  updates: ExpoUpdatesApi = getDefaultUpdatesApi()
): Promise<void> {
  if (!updates.isEnabled) {
    return;
  }

  await updates.reloadAsync();
}

export function getCurrentUpdateInfo(
  updates: ExpoUpdatesApi = getDefaultUpdatesApi()
): CurrentUpdateInfo {
  return {
    enabled: updates.isEnabled,
    updateId: updates.updateId ?? null,
    runtimeVersion: updates.runtimeVersion ?? null,
    channel: updates.channel ?? null
  };
}

function getDefaultUpdatesApi(): ExpoUpdatesApi {
  const updatesModule = require("expo-updates") as ExpoUpdatesApi;
  return updatesModule;
}
