const path = require("node:path");
const { withPlugins, withPodfileProperties } = require("@expo/config-plugins");

/**
 * React Native Firebase ships Swift pods (FirebaseCoreInternal,
 * GoogleUtilities, ...) that CocoaPods refuses to integrate as plain static
 * libraries, so a clean `expo prebuild` fails at `pod install`. The supported
 * configuration for Expo-managed projects is static frameworks
 * (`use_frameworks! :linkage => :static`); the generated Podfile reads it from
 * the `ios.useFrameworks` entry in Podfile.properties.json, which is the same
 * property `expo-build-properties` sets. Setting the property here keeps the
 * requirement owned by the plugin that introduces the Firebase pods.
 */
function applyFirebaseStaticFrameworks(podfileProperties) {
  podfileProperties["ios.useFrameworks"] = "static";
  return podfileProperties;
}

function withFirebaseStaticFrameworks(config) {
  return withPodfileProperties(config, (config) => {
    config.modResults = applyFirebaseStaticFrameworks(config.modResults);
    return config;
  });
}

/**
 * Configure React Native Firebase only for iOS.
 *
 * Kanna currently has Firebase Apple app registrations and GoogleService
 * plists for its native identities, but no committed Android Firebase app or
 * google-services.json. The upstream app plugin registers Android mods
 * unconditionally and would make `expo prebuild --platform android` fail.
 * Resolve its shipped iOS mods directly so iOS gets the supported native
 * initialization without inventing an Android Firebase identity.
 */
function withKannaFirebaseMessaging(config) {
  const appPlugin = require.resolve("@react-native-firebase/app/app.plugin.js");
  const iosPlugin = require(path.join(
    path.dirname(appPlugin),
    "plugin/build/ios"
  ));
  return withPlugins(config, [
    iosPlugin.withFirebaseAppDelegate,
    iosPlugin.withIosGoogleServicesFile,
    withFirebaseStaticFrameworks
  ]);
}

module.exports = withKannaFirebaseMessaging;
module.exports.__internal = {
  applyFirebaseStaticFrameworks,
  withFirebaseStaticFrameworks
};
