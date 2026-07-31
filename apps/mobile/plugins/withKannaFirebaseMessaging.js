const path = require("node:path");
const { withPlugins } = require("@expo/config-plugins");

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
    iosPlugin.withIosGoogleServicesFile
  ]);
}

module.exports = withKannaFirebaseMessaging;
