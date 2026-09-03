const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";

export interface ExpoRelayEnv {
  EXPO_PUBLIC_KANNA_RELAY_URL?: string;
}

export interface RelayUrlOptions {
  customRelayUrl?: string | null;
  dev?: boolean;
  extraRelayUrl?: string | null;
}

export function validateCustomRelayUrl(value: string): string | null {
  const relayUrl = value.trim();
  if (!relayUrl) return "Enter a relay URL.";

  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return "Enter a valid URL.";
  }

  if (parsed.protocol !== "wss:") {
    return "Custom relays must use wss://.";
  }
  if (!parsed.hostname) {
    return "Enter a relay hostname.";
  }
  if (parsed.username || parsed.password) {
    return "Relay URLs cannot include credentials.";
  }
  if (parsed.hash) {
    return "Relay URLs cannot include a fragment.";
  }
  return null;
}

export function normalizeCustomRelayUrl(value: string): string {
  const relayUrl = value.trim();
  const validationError = validateCustomRelayUrl(relayUrl);
  if (validationError) throw new Error(validationError);
  return relayUrl;
}

export function resolveRelayUrl(
  env: ExpoRelayEnv = {},
  options: RelayUrlOptions = {},
): string | null {
  const customRelayUrl = normalizePersistedCustomRelayUrl(options.customRelayUrl);
  if (customRelayUrl) return customRelayUrl;

  if (env.EXPO_PUBLIC_KANNA_RELAY_URL !== undefined) {
    const relayUrl = env.EXPO_PUBLIC_KANNA_RELAY_URL.trim();
    return relayUrl.length > 0 ? relayUrl : null;
  }

  const extraRelayUrl = normalizeOptionalString(options.extraRelayUrl);
  if (extraRelayUrl) return extraRelayUrl;
  if (options.dev === true) return null;
  return PRODUCTION_RELAY_URL;
}

export function normalizePersistedCustomRelayUrl(
  value: unknown
): string | null {
  if (typeof value !== "string" || validateCustomRelayUrl(value)) return null;
  return value.trim();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
