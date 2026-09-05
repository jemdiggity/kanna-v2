const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";

export interface ExpoRelayEnv {
  EXPO_PUBLIC_KANNA_RELAY_URL?: string;
}

export interface RelayUrlOptions {
  appEnv?: string | null;
  customRelayUrl?: string | null;
  dev?: boolean;
  extraRelayUrl?: string | null;
}

// The user-visible custom relay endpoint is hidden in shipped builds (owner
// decision, 2026-09-03). The relay authenticates the phone's Firebase ID token
// and the desktop's credential record against the same Firebase project, so a
// stock App Store or TestFlight build cannot reach a relay backed by somebody
// else's project — the control could not work for the people who would find
// it. The feature's machinery is untouched; only this list hides it.
//
// To restore the feature, add the environments back here (or make
// `isCustomRelayControlEnabled` return true). Nothing else has to change.
export const CUSTOM_RELAY_CONTROL_APP_ENVS: readonly string[] = ["dev"];

// Fails closed: an unknown or missing appEnv hides the control, so a build that
// cannot identify itself never exposes an endpoint its user cannot support.
export function isCustomRelayControlEnabled(
  appEnv: string | null | undefined,
): boolean {
  const name = appEnv?.trim();
  return name ? CUSTOM_RELAY_CONTROL_APP_ENVS.includes(name) : false;
}

// The single funnel for "does this device's stored custom endpoint count?".
// A stored value is deliberately left in AsyncStorage when the control is
// hidden — ignoring it keeps nobody routed through an endpoint they cannot see
// or reset, while re-enabling the control restores their setting untouched.
export function resolveActiveCustomRelayUrl(
  customRelayUrl: unknown,
  controlEnabled: boolean,
): string | null {
  if (!controlEnabled) return null;
  return normalizePersistedCustomRelayUrl(customRelayUrl);
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
  const customRelayUrl = resolveActiveCustomRelayUrl(
    options.customRelayUrl,
    isCustomRelayControlEnabled(options.appEnv),
  );
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
