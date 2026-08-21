export interface KdPorts {
  KANNA_DEV_PORT: number;
  KANNA_WEBDRIVER_PORT: number;
  KANNA_RELAY_PORT: number;
  KANNA_MOBILE_SERVER_PORT: number;
  KANNA_MOBILE_PORT: number;
  KANNA_APPIUM_PORT: number;
  KANNA_TRANSFER_PORT: number;
  KANNA_FIREBASE_AUTH_PORT: number;
  KANNA_FIREBASE_FIRESTORE_PORT: number;
  KANNA_FIREBASE_FUNCTIONS_PORT: number;
  KANNA_FIREBASE_UI_PORT: number;
  KANNA_WEB_PORTAL_PORT: number;
}

export const defaultPorts: KdPorts = {
  KANNA_DEV_PORT: 1420,
  KANNA_WEBDRIVER_PORT: 4445,
  KANNA_RELAY_PORT: 9080,
  KANNA_MOBILE_SERVER_PORT: 48120,
  KANNA_MOBILE_PORT: 8081,
  KANNA_APPIUM_PORT: 4723,
  KANNA_TRANSFER_PORT: 4455,
  KANNA_FIREBASE_AUTH_PORT: 9099,
  KANNA_FIREBASE_FIRESTORE_PORT: 8080,
  KANNA_FIREBASE_FUNCTIONS_PORT: 5001,
  KANNA_FIREBASE_UI_PORT: 4000,
  KANNA_WEB_PORTAL_PORT: 5173
};

export interface ResolvePortsInput {
  env: NodeJS.ProcessEnv;
  configPorts: Record<string, number>;
}

function resolvePort(name: keyof KdPorts, input: ResolvePortsInput): number {
  const envValue = input.env[name];
  if (envValue?.trim()) {
    const parsed = Number(envValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`${name} must be an integer port between 1 and 65535`);
    }
    return parsed;
  }
  return input.configPorts[name] ?? defaultPorts[name];
}

export function resolvePorts(input: ResolvePortsInput): KdPorts {
  return {
    KANNA_DEV_PORT: resolvePort("KANNA_DEV_PORT", input),
    KANNA_WEBDRIVER_PORT: resolvePort("KANNA_WEBDRIVER_PORT", input),
    KANNA_RELAY_PORT: resolvePort("KANNA_RELAY_PORT", input),
    KANNA_MOBILE_SERVER_PORT: resolvePort("KANNA_MOBILE_SERVER_PORT", input),
    KANNA_MOBILE_PORT: resolvePort("KANNA_MOBILE_PORT", input),
    KANNA_APPIUM_PORT: resolvePort("KANNA_APPIUM_PORT", input),
    KANNA_TRANSFER_PORT: resolvePort("KANNA_TRANSFER_PORT", input),
    KANNA_FIREBASE_AUTH_PORT: resolvePort("KANNA_FIREBASE_AUTH_PORT", input),
    KANNA_FIREBASE_FIRESTORE_PORT: resolvePort("KANNA_FIREBASE_FIRESTORE_PORT", input),
    KANNA_FIREBASE_FUNCTIONS_PORT: resolvePort("KANNA_FIREBASE_FUNCTIONS_PORT", input),
    KANNA_FIREBASE_UI_PORT: resolvePort("KANNA_FIREBASE_UI_PORT", input),
    KANNA_WEB_PORTAL_PORT: resolvePort("KANNA_WEB_PORTAL_PORT", input)
  };
}
