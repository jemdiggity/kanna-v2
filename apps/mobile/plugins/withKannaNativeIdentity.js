const { withInfoPlist, withXcodeProject } = require("@expo/config-plugins");

function findAppTargetConfigurationIds(project) {
  const objects = project.hash.project.objects;
  const targets = objects.PBXNativeTarget || {};
  const configurationLists = objects.XCConfigurationList || {};
  const appTarget = Object.values(targets).find(
    (target) => target && typeof target === "object" && target.name === "KannaMobile"
  );
  if (!appTarget?.buildConfigurationList) {
    return [];
  }

  const configurationList = configurationLists[appTarget.buildConfigurationList];
  const buildConfigurations = configurationList?.buildConfigurations || [];
  return buildConfigurations
    .map((configuration) =>
      typeof configuration === "string" ? configuration : configuration?.value
    )
    .filter(Boolean);
}

function setAppTargetBuildSetting(project, key, value) {
  const section = project.hash.project.objects.XCBuildConfiguration || {};
  for (const configId of findAppTargetConfigurationIds(project)) {
    const config = section[configId];
    if (!config || typeof config !== "object") {
      continue;
    }
    config.buildSettings ||= {};
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
    setAppTargetBuildSetting(config.modResults, "PRODUCT_BUNDLE_IDENTIFIER", iosBundleId);
    setAppTargetBuildSetting(config.modResults, "INFOPLIST_KEY_CFBundleDisplayName", displayName);
    return config;
  });
}

module.exports = withKannaNativeIdentity;
module.exports.__internal = {
  findAppTargetConfigurationIds,
  setAppTargetBuildSetting
};
