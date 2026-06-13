import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __internal } = require("../plugins/withKannaNativeIdentity.js");

describe("withKannaNativeIdentity internals", () => {
  it("sets native identity only on the app target build configurations", () => {
    const project = {
      hash: {
        project: {
          objects: {
            PBXNativeTarget: {
              appTarget: {
                name: "KannaMobile",
                buildConfigurationList: "appConfigList"
              },
              testTarget: {
                name: "KannaMobileTests",
                buildConfigurationList: "testConfigList"
              }
            },
            XCConfigurationList: {
              appConfigList: {
                buildConfigurations: [
                  { value: "appDebug" },
                  { value: "appRelease" }
                ]
              },
              testConfigList: {
                buildConfigurations: [{ value: "testDebug" }]
              }
            },
            XCBuildConfiguration: {
              appDebug: { buildSettings: {} },
              appRelease: { buildSettings: {} },
              testDebug: {
                buildSettings: {
                  PRODUCT_BUNDLE_IDENTIFIER: "build.kanna.app.KannaMobileTests"
                }
              }
            }
          }
        }
      }
    };

    __internal.setAppTargetBuildSetting(
      project,
      "PRODUCT_BUNDLE_IDENTIFIER",
      "build.kanna.app.staging"
    );
    __internal.setAppTargetBuildSetting(
      project,
      "INFOPLIST_KEY_CFBundleDisplayName",
      "Kanna Staging"
    );

    expect(project.hash.project.objects.XCBuildConfiguration.appDebug.buildSettings).toEqual({
      PRODUCT_BUNDLE_IDENTIFIER: "build.kanna.app.staging",
      INFOPLIST_KEY_CFBundleDisplayName: "Kanna Staging"
    });
    expect(project.hash.project.objects.XCBuildConfiguration.appRelease.buildSettings).toEqual({
      PRODUCT_BUNDLE_IDENTIFIER: "build.kanna.app.staging",
      INFOPLIST_KEY_CFBundleDisplayName: "Kanna Staging"
    });
    expect(project.hash.project.objects.XCBuildConfiguration.testDebug.buildSettings).toEqual({
      PRODUCT_BUNDLE_IDENTIFIER: "build.kanna.app.KannaMobileTests"
    });
  });
});
