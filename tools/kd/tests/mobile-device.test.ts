import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMobileDeviceInstallAppCommand,
  buildMobileDeviceLaunchAppCommand,
  buildMobileDeviceListAppsCommand,
  buildMobileDevicePrebuildCommand,
  buildMobileDeviceRelaunchCommand,
  buildMobileDeviceReleaseBuildCommand,
  buildMobileDeviceRunCommand,
  buildMobileDeviceUninstallAppCommand,
  buildMobileSimulatorBootCommandPlan,
  checkPhysicalDeviceRunPreflight,
  mobileDeviceDerivedDataPath,
  isMobileDeviceAppInstalled,
  resolveMobileIosWorkspace,
  resolveMobileReleaseAppPath,
  waitForPhysicalDeviceMetroReadiness,
  resolveMobileNativeIdentity,
  parseXcdeviceList,
  parseSimctlDeviceList,
  selectPhysicalDevice,
  selectSimulatorDevice
} from "../src/runtime/mobile-device";
import type { CommandRunner } from "../src/runtime/process";

function device(name: string, udid: string) {
  return { name, udid, platformVersion: "17.5" };
}

describe("physical-device mobile runtime", () => {
  it("selects the requested attached iPhone by UDID or name", () => {
    const devices = [
      device("Jeremy's iPhone", "udid-1"),
      device("Jerome's iPhone 15", "udid-2")
    ];

    expect(selectPhysicalDevice(devices, { requestedUdid: "udid-2" })).toMatchObject({
      name: "Jerome's iPhone 15",
      udid: "udid-2"
    });
    expect(selectPhysicalDevice(devices, { requestedName: "Jeremy's iPhone" })).toMatchObject({
      name: "Jeremy's iPhone",
      udid: "udid-1"
    });
  });

  it("parses attached physical iPhones from xcdevice JSON", () => {
    expect(
      parseXcdeviceList(`[
        {
          "available": true,
          "identifier": "00008130-001015CA1091401C",
          "name": "Jerome's iPhone 15",
          "operatingSystemVersion": "17.5 (21F79)",
          "platform": "com.apple.platform.iphoneos",
          "simulator": false
        },
        {
          "available": true,
          "identifier": "390F2D5A-D8FE-40BC-9D42-DBA11DD35BF2",
          "name": "iPhone 15",
          "platform": "com.apple.platform.iphonesimulator",
          "simulator": true
        }
      ]`)
    ).toEqual([
      {
        name: "Jerome's iPhone 15",
        udid: "00008130-001015CA1091401C",
        platformVersion: "17.5"
      }
    ]);
  });

  it("resolves the native bundle id and display name from KANNA_APP_ENV", () => {
    expect(resolveMobileNativeIdentity({ KANNA_APP_ENV: "dev" })).toEqual({
      appEnv: "dev",
      bundleId: "build.kanna.app.dev",
      devClientScheme: "exp+kanna-mobile",
      displayName: "Kanna Dev"
    });
    expect(resolveMobileNativeIdentity({ KANNA_APP_ENV: "staging" })).toEqual({
      appEnv: "staging",
      bundleId: "build.kanna.app.staging",
      devClientScheme: "exp+kanna-mobile",
      displayName: "Kanna Staging"
    });
    expect(resolveMobileNativeIdentity({ KANNA_APP_ENV: "production" })).toEqual({
      appEnv: "prod",
      bundleId: "build.kanna.app",
      devClientScheme: "exp+kanna-mobile",
      displayName: "Kanna"
    });
  });

  it("builds an Expo prebuild command that applies app config and config plugins", () => {
    const command = buildMobileDevicePrebuildCommand({
      repoRoot: "/repo",
      nativeIdentity: {
        appEnv: "staging",
        bundleId: "build.kanna.app.staging",
        devClientScheme: "exp+kanna-mobile",
        displayName: "Kanna Staging"
      }
    });

    expect(command).toEqual({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "exec", "expo", "prebuild", "--platform", "ios"],
      cwd: "/repo",
      env: {
        KANNA_APP_ENV: "staging"
      }
    });
    // The command contributes native identity only. app.config.ts resolves the
    // independent mobile marketing version unless the caller supplied an
    // explicit KANNA_APP_VERSION override in the complete environment.
    expect(command.env).not.toHaveProperty("KANNA_APP_VERSION");
  });

  it("builds and launches through the worktree Metro on the Mac LAN IP with native identity env", () => {
    const command = buildMobileDeviceRunCommand({
      repoRoot: "/repo",
      deviceUdid: "00008130-001015CA1091401C",
      lanHost: "172.16.0.193",
      metroPort: 1430,
      nativeIdentity: {
        appEnv: "dev",
        bundleId: "build.kanna.app.dev",
        devClientScheme: "exp+kanna-mobile",
        displayName: "Kanna Dev"
      }
    });

    expect(command).toEqual({
      command: "pnpm",
      args: [
        "--dir",
        "/repo/apps/mobile",
        "ios",
        "--device",
        "00008130-001015CA1091401C",
        "--port",
        "1430"
      ],
      cwd: "/repo",
      env: {
        KANNA_APP_ENV: "dev",
        REACT_NATIVE_PACKAGER_HOSTNAME: "172.16.0.193",
        RCT_METRO_PORT: "1430"
      }
    });
  });

  it("checks LAN Metro reachability and installed app state with guidance", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "xcrun") {
          return { exitCode: 0, stdout: "build.kanna.app.dev\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await checkPhysicalDeviceRunPreflight(runner, {
      bundleId: "build.kanna.app.dev",
      device: device("Jerome's iPhone 15", "00008130-001015CA1091401C"),
      lanHost: "172.16.0.193",
      metroPort: 1430
    });

    expect(result.ok).toBe(true);
    expect(result.metroUrl).toBe("http://172.16.0.193:1430");
    expect(result.checks).toEqual([
      { name: "metro-lan", ok: true, message: "Metro is reachable at http://172.16.0.193:1430/status." },
      { name: "app-installed", ok: true, message: "build.kanna.app.dev is installed on Jerome's iPhone 15." },
      {
        name: "local-network-permission",
        ok: true,
        message: "On the iPhone, allow Local Network for Kanna in Settings -> Privacy & Security -> Local Network."
      }
    ]);
    expect(calls).toEqual([
      "curl --fail --silent --show-error http://172.16.0.193:1430/status",
      "xcrun devicectl device info apps --device 00008130-001015CA1091401C"
    ]);
  });

  it("retries the LAN Metro status endpoint until it is reachable", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        attempts += 1;
        return attempts < 3
          ? { exitCode: 7, stdout: "", stderr: "Failed to connect" }
          : { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
      }
    };

    const result = await waitForPhysicalDeviceMetroReadiness(runner, {
      lanHost: "172.16.0.193",
      metroPort: 1430,
      attempts: 3,
      delayMs: 0
    });

    expect(result).toEqual({
      ok: true,
      metroUrl: "http://172.16.0.193:1430",
      attempts: 3,
      message: "Metro is reachable at http://172.16.0.193:1430/status."
    });
    expect(calls).toEqual([
      "curl --fail --silent --show-error http://172.16.0.193:1430/status",
      "curl --fail --silent --show-error http://172.16.0.193:1430/status",
      "curl --fail --silent --show-error http://172.16.0.193:1430/status"
    ]);
  });

  it("reports a clear Metro failure after readiness retries are exhausted", async () => {
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 7, stdout: "", stderr: "Failed to connect" };
      }
    };

    const result = await waitForPhysicalDeviceMetroReadiness(runner, {
      lanHost: "172.16.0.193",
      metroPort: 1430,
      attempts: 2,
      delayMs: 0
    });

    expect(result).toEqual({
      ok: false,
      metroUrl: "http://172.16.0.193:1430",
      attempts: 2,
      message:
        "Metro is not reachable at http://172.16.0.193:1430/status after 2 attempts. " +
        "\"No script URL provided\" usually means Metro is down, the iPhone cannot reach the printed LAN URL, or Local Network permission is off."
    });
  });

  it("builds a Release xcodebuild command that allows automatic provisioning updates", () => {
    const command = buildMobileDeviceReleaseBuildCommand({
      repoRoot: "/repo",
      deviceUdid: "00008130-001015CA1091401C",
      derivedDataPath: "/repo/.build/mobile/ios-device-staging",
      nativeIdentity: {
        appEnv: "staging",
        bundleId: "build.kanna.app.staging",
        devClientScheme: "exp+kanna-mobile",
        displayName: "Kanna Staging"
      },
      workspace: {
        scheme: "KannaStaging",
        workspacePath: "/repo/apps/mobile/ios/KannaStaging.xcworkspace"
      }
    });

    expect(command).toEqual({
      command: "xcodebuild",
      args: [
        "-workspace",
        "/repo/apps/mobile/ios/KannaStaging.xcworkspace",
        "-scheme",
        "KannaStaging",
        "-configuration",
        "Release",
        "-destination",
        "id=00008130-001015CA1091401C",
        "-derivedDataPath",
        "/repo/.build/mobile/ios-device-staging",
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        "build"
      ],
      cwd: "/repo",
      env: {
        KANNA_APP_ENV: "staging"
      }
    });
  });

  it("keeps the Release derived data under .build per environment", () => {
    expect(mobileDeviceDerivedDataPath("/repo", "staging")).toBe(
      join("/repo", ".build", "mobile", "ios-device-staging")
    );
  });

  it("resolves the generated Xcode workspace and Release app product", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-mobile-workspace-"));
    await mkdir(join(repoRoot, "apps", "mobile", "ios", "KannaStaging.xcworkspace"), {
      recursive: true
    });
    const derivedDataPath = join(repoRoot, ".build", "mobile", "ios-device-staging");
    await mkdir(join(derivedDataPath, "Build", "Products", "Release-iphoneos", "KannaStaging.app"), {
      recursive: true
    });

    expect(resolveMobileIosWorkspace(repoRoot)).toEqual({
      scheme: "KannaStaging",
      workspacePath: join(repoRoot, "apps", "mobile", "ios", "KannaStaging.xcworkspace")
    });
    expect(resolveMobileReleaseAppPath(derivedDataPath)).toBe(
      join(derivedDataPath, "Build", "Products", "Release-iphoneos", "KannaStaging.app")
    );
  });

  it("fails clearly when pod install produced no workspace or the build produced no app", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-mobile-no-workspace-"));
    await mkdir(join(repoRoot, "apps", "mobile", "ios"), { recursive: true });

    expect(() => resolveMobileIosWorkspace(repoRoot)).toThrow(
      /A missing workspace usually means pod install failed/
    );
    expect(() => resolveMobileReleaseAppPath(join(repoRoot, ".build", "missing"))).toThrow(
      /Expected exactly one \.app/
    );
  });

  it("builds devicectl install and launch commands for the Release app", () => {
    expect(
      buildMobileDeviceInstallAppCommand({
        appPath: "/repo/.build/mobile/ios-device-staging/Build/Products/Release-iphoneos/KannaStaging.app",
        deviceUdid: "00008130-001015CA1091401C"
      })
    ).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        "00008130-001015CA1091401C",
        "/repo/.build/mobile/ios-device-staging/Build/Products/Release-iphoneos/KannaStaging.app"
      ]
    });
    expect(
      buildMobileDeviceLaunchAppCommand({
        bundleId: "build.kanna.app.staging",
        deviceUdid: "00008130-001015CA1091401C"
      })
    ).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        "00008130-001015CA1091401C",
        "build.kanna.app.staging"
      ]
    });
  });

  it("builds devicectl installed-app inspection and single-bundle uninstall commands", () => {
    expect(
      buildMobileDeviceListAppsCommand({ deviceUdid: "00008130-001015CA1091401C" })
    ).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "info",
        "apps",
        "--device",
        "00008130-001015CA1091401C"
      ]
    });
    expect(
      buildMobileDeviceUninstallAppCommand({
        bundleId: "build.kanna.app.staging",
        deviceUdid: "00008130-001015CA1091401C"
      })
    ).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "uninstall",
        "app",
        "--device",
        "00008130-001015CA1091401C",
        "build.kanna.app.staging"
      ]
    });
  });

  it("matches installed bundle ids exactly", () => {
    const installedApps = [
      "Kanna Staging    build.kanna.app.staging",
      "Kanna Dev        build.kanna.app.dev"
    ].join("\n");

    expect(isMobileDeviceAppInstalled(installedApps, "build.kanna.app.staging")).toBe(true);
    expect(isMobileDeviceAppInstalled(installedApps, "build.kanna.app")).toBe(false);
  });

  it("builds a direct installed-app relaunch command for the resolved device and bundle id", () => {
    expect(
      buildMobileDeviceRelaunchCommand({
        bundleId: "build.kanna.app.dev",
        devClientScheme: "exp+kanna-mobile",
        deviceUdid: "00008130-001015CA1091401C",
        lanHost: "172.16.0.193",
        metroPort: 1430
      })
    ).toEqual({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        "00008130-001015CA1091401C",
        "--payload-url",
        "exp+kanna-mobile://expo-development-client/?url=http%3A%2F%2F172.16.0.193%3A1430",
        "build.kanna.app.dev"
      ]
    });
  });
});

describe("simulator mobile runtime", () => {
  const simulatorList = `{
    "devices": {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
        {
          "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
          "isAvailable": true,
          "lastBootedAt": "2026-09-03T06:55:38Z",
          "name": "iPhone 16 Pro",
          "state": "Booted",
          "udid": "booted-18"
        },
        {
          "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
          "isAvailable": true,
          "name": "iPad (A16)",
          "state": "Shutdown",
          "udid": "ipad-18"
        }
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
        {
          "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          "isAvailable": true,
          "name": "iPhone 17 Pro",
          "state": "Shutdown",
          "udid": "newest-26"
        }
      ]
    }
  }`;

  it("parses available iPhones and prefers a booted simulator", () => {
    const devices = parseSimctlDeviceList(simulatorList);

    expect(devices.map((entry) => entry.udid)).toEqual(["booted-18", "newest-26"]);
    expect(selectSimulatorDevice(devices)).toMatchObject({
      name: "iPhone 16 Pro",
      state: "Booted",
      udid: "booted-18"
    });
  });

  it("selects an explicit simulator by UDID or name and lists choices on failure", () => {
    const devices = parseSimctlDeviceList(simulatorList);

    expect(selectSimulatorDevice(devices, "newest-26")).toMatchObject({
      name: "iPhone 17 Pro"
    });
    expect(selectSimulatorDevice(devices, "iPhone 17 Pro")).toMatchObject({
      udid: "newest-26"
    });
    expect(() => selectSimulatorDevice(devices, "iPhone 15")).toThrow(
      /Available simulators: iPhone 16 Pro \(booted-18, iOS-18-5\), iPhone 17 Pro \(newest-26, iOS-26-2\)/
    );
  });

  it("defaults to an iPhone on the newest runtime when none is booted", () => {
    const devices = parseSimctlDeviceList(simulatorList).map((entry) => ({
      ...entry,
      state: "Shutdown"
    }));

    expect(selectSimulatorDevice(devices)).toMatchObject({
      name: "iPhone 17 Pro",
      udid: "newest-26"
    });
  });

  it("plans simulator boot, readiness, UI opening, and Expo install/launch", () => {
    const simulator = {
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      name: "iPhone 17 Pro",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
      state: "Shutdown",
      udid: "simulator-udid"
    };

    expect(buildMobileSimulatorBootCommandPlan(simulator)).toEqual([
      { command: "xcrun", args: ["simctl", "boot", "simulator-udid"] },
      { command: "xcrun", args: ["simctl", "bootstatus", "simulator-udid", "-b"] },
      {
        command: "open",
        args: ["-a", "Simulator", "--args", "-CurrentDeviceUDID", "simulator-udid"]
      }
    ]);
    expect(buildMobileDeviceRunCommand({
      repoRoot: "/repo",
      deviceUdid: "simulator-udid",
      lanHost: "127.0.0.1",
      metroPort: 1430,
      nativeIdentity: {
        appEnv: "dev",
        bundleId: "build.kanna.app.dev",
        devClientScheme: "exp+kanna-mobile",
        displayName: "Kanna Dev"
      }
    })).toMatchObject({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "ios", "--device", "simulator-udid", "--port", "1430"],
      env: {
        KANNA_APP_ENV: "dev",
        REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
        RCT_METRO_PORT: "1430"
      }
    });
  });

  it("does not plan a redundant boot for an already booted simulator", () => {
    const simulator = selectSimulatorDevice(parseSimctlDeviceList(simulatorList));
    expect(buildMobileSimulatorBootCommandPlan(simulator)[0]).toEqual({
      command: "xcrun",
      args: ["simctl", "bootstatus", "booted-18", "-b"]
    });
  });
});
