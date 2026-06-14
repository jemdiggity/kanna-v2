import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../scripts/provision-staging-buffy-user.mjs")
).href;

describe("staging Buffy user provisioning script", () => {
  it("describes the persistent staging Buffy user and relay device document", async () => {
    const script = await import(scriptUrl);

    // The password is sourced from KANNA_STAGING_TEST_PASSWORD and is never
    // committed; with no env set it defaults to an empty placeholder.
    expect(script.BUFFY_USER).toEqual({
      projectId: "kanna-staging",
      email: "glass_galleon.3m@icloud.com",
      password: "",
      displayName: "Buffy the Bug Slayer",
      photoURL: "file://services/firebase/emulator-seed/assets/buffy-avatar.jpg",
      deviceToken: "staging-buffy-device-token"
    });
    expect(script.buildDeviceDocument("buffy-user-uid")).toMatchObject({
      userId: "buffy-user-uid",
      email: "glass_galleon.3m@icloud.com",
      displayName: "Buffy the Bug Slayer",
      environment: "staging"
    });
    expect(script.buildDryRunResult()).toMatchObject({
      projectId: "kanna-staging",
      uid: "dry-run-buffy-user",
      devicePath: "devices/staging-buffy-device-token",
      dryRun: true
    });
  });
});
