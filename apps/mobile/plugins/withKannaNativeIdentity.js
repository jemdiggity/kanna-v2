const { withInfoPlist, withXcodeProject } = require("@expo/config-plugins");

function setBuildSetting(project, key, value) {
  const section = project.hash.project.objects.XCBuildConfiguration || {};
  for (const config of Object.values(section)) {
    if (!config || typeof config !== "object" || !config.buildSettings) {
      continue;
    }
    config.buildSettings[key] = value;
  }
}

function withKannaNativeIdentity(config, options = {}) {
  const displayName = options.displayName || config.name || "Kanna";
  const iosBundleId = options.iosBundleId || config.ios?.bundleIdentifier || "build.kanna.app";

  config = withInfoPlist(config, (config) => {
    config.modResults.CFBundleDisplayName = displayName;
    config.modResults.CFBundleName = displayName;
    return config;
  });

  return withXcodeProject(config, (config) => {
    setBuildSetting(config.modResults, "PRODUCT_BUNDLE_IDENTIFIER", iosBundleId);
    setBuildSetting(config.modResults, "INFOPLIST_KEY_CFBundleDisplayName", displayName);
    return config;
  });
}

module.exports = withKannaNativeIdentity;
