import { describe, expect, it } from "vitest";
import { buildRelayDeployPlan } from "./cloud-deploy.js";

describe("relay deploy plan", () => {
  it("passes OTA bucket and private key secret wiring to the relay VM", () => {
    const plan = buildRelayDeployPlan({
      repoRoot: "/repo",
      environment: "staging",
      commit: "1f2e3d4c5b6a",
    });

    const remote = plan.commands.at(-1);
    expect(remote?.args.join("\n")).toContain("kanna-mobile-ota-private-key-pem");
    expect(remote?.args.join("\n")).toContain("KANNA_OTA_BUCKET=kanna-staging.firebasestorage.app");
    expect(remote?.args.join("\n")).toContain("KANNA_OTA_KEY_ID=kanna-mobile-ota-v1");
    expect(remote?.args.join("\n")).toContain("KANNA_OTA_PRIVATE_KEY_PATH=/run/secrets/kanna_ota_private_key.pem");
  });
});
