export interface ExpoConfigLike {
  extra?: unknown;
}

interface ExpoConstantsModule {
  default?: {
    expoConfig?: ExpoConfigLike | null;
  };
  expoConfig?: ExpoConfigLike | null;
}

export function readExpoConfig(): ExpoConfigLike | null {
  try {
    const expoConstants = require("expo-constants") as ExpoConstantsModule;
    return expoConstants.default?.expoConfig ?? expoConstants.expoConfig ?? null;
  } catch {
    return null;
  }
}
