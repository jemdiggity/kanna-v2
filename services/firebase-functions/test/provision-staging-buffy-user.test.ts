import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../scripts/provision-staging-buffy-user.mjs")
).href;

describe("staging Buffy user provisioning script", () => {
  it("describes the persistent staging Buffy user and relay device document", async () => {
    const script = await import(scriptUrl);

    expect(script.BUFFY_USER).toEqual({
      projectId: "kanna-staging",
      email: "upvote.sieve.7t@icloud.com",
      password: "password123",
      displayName: "Buffy the Bug Slayer",
      photoURL: "file://services/firebase/emulator-seed/assets/buffy-avatar.jpg",
      deviceToken: "staging-buffy-device-token"
    });
    expect(script.buildDeviceDocument("buffy-user-uid")).toMatchObject({
      userId: "buffy-user-uid",
      email: "upvote.sieve.7t@icloud.com",
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
