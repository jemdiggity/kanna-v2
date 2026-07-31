const { withPodfileProperties } = require("@expo/config-plugins");

/**
 * React Native Firebase packages are autolinked in every app environment,
 * including dev where Kanna intentionally skips Firebase AppDelegate and
 * GoogleService plist initialization. Their Swift pods therefore require
 * static frameworks for every generated iOS project.
 *
 * The generated Podfile reads this Expo-managed property and emits
 * `use_frameworks! :linkage => :static`, matching expo-build-properties
 * without adding that dependency or editing generated files.
 */
function applyFirebaseStaticFrameworks(podfileProperties) {
  podfileProperties["ios.useFrameworks"] = "static";
  return podfileProperties;
}

function withKannaFirebasePodfile(config) {
  return withPodfileProperties(config, (config) => {
    config.modResults = applyFirebaseStaticFrameworks(config.modResults);
    return config;
  });
}

module.exports = withKannaFirebasePodfile;
module.exports.__internal = {
  applyFirebaseStaticFrameworks
};
