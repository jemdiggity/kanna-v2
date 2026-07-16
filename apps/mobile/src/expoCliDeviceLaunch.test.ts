import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("Expo CLI physical-device launch", () => {
  it("terminates an already-running app before launching it with devicectl", () => {
    const expoPackagePath = require.resolve("expo/package.json");
    const expoRequire = createRequire(expoPackagePath);
    const cliPackagePath = expoRequire.resolve("@expo/cli/package.json");
    const source = readFileSync(
      join(
        dirname(cliPackagePath),
        "build/src/start/platforms/ios/devicectl.js"
      ),
      "utf8"
    );
    const launchFunction = source.slice(
      source.indexOf("async function launchAppWithDeviceCtl"),
      source.indexOf("/** Find all error codes", source.indexOf("async function launchAppWithDeviceCtl"))
    );

    expect(launchFunction).toMatch(
      /'launch',\s*'--terminate-existing',\s*'--device',\s*deviceId,\s*bundleId/
    );
  });
});
