import { describe, expect, it, vi } from "vitest";
import { checkAndFetchUpdate, type ExpoUpdatesApi } from "./otaUpdates";

function createUpdatesApi(
  overrides: Partial<ExpoUpdatesApi>
): ExpoUpdatesApi {
  return {
    isEnabled: true,
    updateId: "update-1",
    runtimeVersion: "1.0.0",
    channel: "staging",
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: false })),
    reloadAsync: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("checkAndFetchUpdate", () => {
  it("returns up-to-date without fetching when no update is available", async () => {
    const updates = createUpdatesApi({
      checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false }))
    });

    await expect(checkAndFetchUpdate(updates)).resolves.toEqual({
      state: "up-to-date"
    });
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it("fetches and reports downloaded when an update is available", async () => {
    const updates = createUpdatesApi({
      checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
      fetchUpdateAsync: vi.fn(async () => ({ isNew: true }))
    });

    await expect(checkAndFetchUpdate(updates)).resolves.toEqual({
      state: "downloaded"
    });
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
  });

  it("returns an error state when checking fails", async () => {
    const updates = createUpdatesApi({
      checkForUpdateAsync: vi.fn(async () => {
        throw new Error("manifest rejected");
      })
    });

    await expect(checkAndFetchUpdate(updates)).resolves.toEqual({
      state: "error",
      error: expect.any(Error)
    });
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it("is inert when expo-updates is disabled in dev or Expo Go", async () => {
    const updates = createUpdatesApi({ isEnabled: false });

    await expect(checkAndFetchUpdate(updates)).resolves.toEqual({
      state: "up-to-date"
    });
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });
});
