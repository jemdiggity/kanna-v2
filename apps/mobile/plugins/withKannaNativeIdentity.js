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

// pbxproj build-setting values that are not bare identifiers (e.g. a display
// name with a space like "Kanna Staging") MUST be double-quoted, or Xcode
// reports the project as "damaged ... parse error" and the build fails. The
// underlying xcode writer does not add quotes for a directly-assigned value, so
// quote them here. Bare values (a bundle id like build.kanna.app.dev) are left
// as-is.
function quotePbxprojValue(value) {
  if (/^[A-Za-z0-9_.$/()-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function setAppTargetBuildSetting(project, key, value) {
  const section = project.hash.project.objects.XCBuildConfiguration || {};
  for (const configId of findAppTargetConfigurationIds(project)) {
    const config = section[configId];
    if (!config || typeof config !== "object") {
      continue;
    }
    config.buildSettings ||= {};
    config.buildSettings[key] = quotePbxprojValue(value);
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
  setAppTargetBuildSetting,
  quotePbxprojValue
};
