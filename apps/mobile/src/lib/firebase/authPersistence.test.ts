import { describe, expect, it, vi } from "vitest";
import { createReactNativeAuthPersistence } from "./authPersistence";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    values
  };
}

describe("createReactNativeAuthPersistence", () => {
  it("stores and reads Firebase auth values through AsyncStorage", async () => {
    const storage = createStorage();
    const Persistence = createReactNativeAuthPersistence(storage);
    const persistence = new Persistence();

    expect(Persistence.type).toBe("LOCAL");
    expect(persistence.type).toBe("LOCAL");
    await expect(persistence._isAvailable()).resolves.toBe(true);

    await persistence._set("auth-user", { uid: "user-1" });

    expect(storage.setItem).toHaveBeenCalledWith(
      "firebaseAuth:auth-user",
      "{\"uid\":\"user-1\"}"
    );
    await expect(persistence._get("auth-user")).resolves.toEqual({ uid: "user-1" });

    await persistence._remove("auth-user");

    expect(storage.removeItem).toHaveBeenCalledWith("firebaseAuth:auth-user");
    await expect(persistence._get("auth-user")).resolves.toBeNull();
  });

  it("returns null for missing or invalid stored auth values", async () => {
    const storage = createStorage();
    storage.values.set("firebaseAuth:invalid", "{");
    const Persistence = createReactNativeAuthPersistence(storage);
    const persistence = new Persistence();

    await expect(persistence._get("missing")).resolves.toBeNull();
    await expect(persistence._get("invalid")).resolves.toBeNull();
  });
});
