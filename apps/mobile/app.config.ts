import type { MobileAppEnvironment } from "./src/mobileEnvironment";
import { resolveMobileAppEnvironment } from "./src/mobileEnvironment";

interface ExpoConfig {
  name: string;
  slug: string;
  scheme: string;
  icon: string;
  plugins: string[];
  platforms: string[];
  ios: {
    bundleIdentifier: string;
    appleTeamId: string;
    googleServicesFile: string;
  };
  extra: {
    kanna: {
      appEnv: MobileAppEnvironment["name"];
      firebase: MobileAppEnvironment["firebase"];
      relayUrl: string;
    };
  };
}

export function createExpoConfig(
  env: { KANNA_APP_ENV?: string }
): ExpoConfig {
  const appEnvironment = resolveMobileAppEnvironment(env.KANNA_APP_ENV);

  return {
    name: appEnvironment.displayName,
    slug: "kanna-mobile",
    scheme: appEnvironment.scheme,
    icon: "./assets/icon.png",
    plugins: ["./plugins/withKannaBonjour"],
    platforms: ["ios", "android"],
    ios: {
      bundleIdentifier: appEnvironment.iosBundleId,
      appleTeamId: "GY3LFAA59P",
      googleServicesFile: appEnvironment.iosGoogleServicesFile
    },
    extra: {
      kanna: {
        appEnv: appEnvironment.name,
        firebase: appEnvironment.firebase,
        relayUrl: appEnvironment.relayUrl
      }
    }
  };
}

export { resolveMobileAppEnvironment };

export default createExpoConfig(process.env);
