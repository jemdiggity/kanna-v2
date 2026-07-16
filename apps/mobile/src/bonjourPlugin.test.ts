import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { __internal } = require("../plugins/withKannaBonjour.js");

describe("withKannaBonjour internals", () => {
  it("writes App Store-safe local network permission metadata", () => {
    const plist = __internal.applyInfoPlist({});

    expect(plist.NSBonjourServices).toEqual(["_kanna-mobile._tcp"]);
    expect(plist.NSLocalNetworkUsageDescription).toBe(
      "Kanna uses your local network to find and connect to your paired Kanna desktop app."
    );
  });

  it("deduplicates the Bonjour service and replaces stale permission copy", () => {
    const plist = __internal.applyInfoPlist({
      NSBonjourServices: ["_kanna-mobile._tcp", "_example._tcp"],
      NSLocalNetworkUsageDescription: "Old copy"
    });

    expect(plist.NSBonjourServices).toEqual([
      "_kanna-mobile._tcp",
      "_example._tcp"
    ]);
    expect(plist.NSLocalNetworkUsageDescription).toBe(
      "Kanna uses your local network to find and connect to your paired Kanna desktop app."
    );
  });

  it("patches the SDK AppDelegate with the physical-device Metro endpoint", () => {
    const appDelegate = `import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

    const patched = __internal.patchAppDelegate(appDelegate);

    expect(patched).toContain("return kannaMetroBundleURL()");
    expect(patched).toContain('let host = readBundledTextResource("ip")');
    expect(patched).toContain('let port = readBundledTextResource("metro-port") ?? "8081"');
    expect(__internal.patchAppDelegate(patched)).toBe(patched);
  });

  it("fails when the Expo AppDelegate template no longer matches", () => {
    expect(() => __internal.patchAppDelegate("class AppDelegate: ExpoAppDelegate {}"))
      .toThrow("Unsupported Expo AppDelegate template");
  });

  it("adds the Metro port resource step to the React Native bundle phase once", () => {
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {
              bundlePhase: {
                name: '"Bundle React Native code and images"',
                shellScript:
                  'set -e\nexport PROJECT_ROOT=\\"$PROJECT_DIR\\"/..\\n\\n/bin/sh `node --print "require(\'react-native/package.json\').bin"`\n'
              }
            }
          }
        }
      }
    };

    __internal.patchMetroPortScript(project);
    const once = project.hash.project.objects.PBXShellScriptBuildPhase.bundlePhase.shellScript;
    __internal.patchMetroPortScript(project);

    expect(once).toContain('echo \\"${RCT_METRO_PORT:-8081}\\" >');
    expect(project.hash.project.objects.PBXShellScriptBuildPhase.bundlePhase.shellScript).toBe(once);
  });

  it("fails when the React Native bundle phase no longer matches", () => {
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {}
          }
        }
      }
    };

    expect(() => __internal.patchMetroPortScript(project))
      .toThrow("Unsupported React Native bundle phase template");
  });
});
