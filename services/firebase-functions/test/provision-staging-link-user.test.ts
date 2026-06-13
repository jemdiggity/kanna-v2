import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../scripts/provision-staging-link-user.mjs")
).href;

describe("staging Link user provisioning script", () => {
  it("describes the persistent staging Link user and relay device document", async () => {
    const script = await import(scriptUrl);

    expect(script.LINK_USER).toEqual({
      projectId: "kanna-staging",
      email: "upvote.sieve.7t@icloud.com",
      password: "password123",
      displayName: "Link",
      photoURL: "file://services/firebase/emulator-seed/assets/link-avatar.png",
      deviceToken: "staging-link-device-token"
    });
    expect(script.buildDeviceDocument("link-user-uid")).toMatchObject({
      userId: "link-user-uid",
      email: "upvote.sieve.7t@icloud.com",
      displayName: "Link",
      environment: "staging"
    });
    expect(script.buildDryRunResult()).toMatchObject({
      projectId: "kanna-staging",
      uid: "dry-run-link-user",
      devicePath: "devices/staging-link-device-token",
      dryRun: true
    });
  });
});
