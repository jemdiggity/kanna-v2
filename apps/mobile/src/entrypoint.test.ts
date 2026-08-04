import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = path.resolve(__dirname, "..");

describe("mobile Expo entrypoint", () => {
  it("uses a local index entry instead of expo/AppEntry", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(mobileRoot, "package.json"), "utf8")
    ) as { main?: string };

    expect(packageJson.main).toBe("index.js");
  });

  it("registers the app from the local App module", () => {
    const entrySource = readFileSync(path.join(mobileRoot, "index.js"), "utf8");

    expect(entrySource).toContain("registerRootComponent");
    expect(entrySource).toContain('./App');
    expect(entrySource).toContain("installMobileCrashHandler");
    expect(entrySource.indexOf("installMobileCrashHandler();")).toBeLessThan(
      entrySource.indexOf('require("./App")')
    );
  });

  it("provides the screen factory required by native-stack", () => {
    const mobileRequire = createRequire(path.join(mobileRoot, "package.json"));
    const nativePackagePath = mobileRequire.resolve("@react-navigation/native/package.json");
    const nativeRequire = createRequire(nativePackagePath);
    const corePackagePath = nativeRequire.resolve("@react-navigation/core/package.json");
    const corePackage = JSON.parse(readFileSync(corePackagePath, "utf8")) as {
      main: string;
    };
    const coreEntry = readFileSync(
      path.resolve(path.dirname(corePackagePath), corePackage.main),
      "utf8"
    );

    expect(coreEntry).toContain("createScreenFactory");
  });
});
