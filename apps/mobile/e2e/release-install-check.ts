// E2E check for the Release device install path (`kd mobile run --device
// --install`): verifies the environment's bundle is installed on the attached
// iPhone and that it launches. Unlike the dev-client smoke, this needs no
// Metro, Appium, or desktop server — the Release app bundles its JavaScript.
import { resolvePhysicalDevice } from "./helpers/device";
import {
  assertReleaseAppInstalled,
  launchReleaseApp,
  resolveReleaseInstallTarget
} from "./helpers/release-install";

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const target = resolveReleaseInstallTarget(env);
  const device = await resolvePhysicalDevice(
    env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    undefined,
    env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined
  );

  await assertReleaseAppInstalled(device, target);
  await launchReleaseApp(device, target);

  process.stdout.write(
    `${JSON.stringify(
      {
        appEnv: target.appEnv,
        bundleId: target.bundleId,
        displayName: target.displayName,
        runtimeVersion: target.runtimeVersion,
        deviceName: device.name,
        deviceUdid: device.udid,
        platformVersion: device.platformVersion,
        launched: true
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
