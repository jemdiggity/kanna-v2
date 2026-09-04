import { describe, expect, it } from "vitest";
import {
  CUSTOM_RELAY_CONTROL_APP_ENVS,
  isCustomRelayControlEnabled,
  normalizePersistedCustomRelayUrl,
  resolveActiveCustomRelayUrl,
  resolveRelayUrl,
  validateCustomRelayUrl
} from "./relaySettings";

describe("relay settings", () => {
  it("gives a custom relay precedence over build-time environment values", () => {
    expect(resolveRelayUrl(
      { EXPO_PUBLIC_KANNA_RELAY_URL: "wss://environment.example" },
      {
        appEnv: "dev",
        customRelayUrl: " wss://self-hosted.example/relay ",
        extraRelayUrl: "wss://baked.example"
      }
    )).toBe("wss://self-hosted.example/relay");
  });

  it("falls back through public env, baked extra, dev, and production defaults", () => {
    expect(resolveRelayUrl(
      { EXPO_PUBLIC_KANNA_RELAY_URL: "wss://environment.example" },
      { extraRelayUrl: "wss://baked.example" }
    )).toBe("wss://environment.example");
    expect(resolveRelayUrl({}, { extraRelayUrl: "wss://baked.example" }))
      .toBe("wss://baked.example");
    expect(resolveRelayUrl({}, { dev: true })).toBeNull();
    expect(resolveRelayUrl()).toBe("wss://relay.kanna.build");
  });

  it.each([
    ["", "Enter a relay URL."],
    ["relay.example", "Enter a valid URL."],
    ["https://relay.example", "Custom relays must use wss://."],
    ["ws://relay.example", "Custom relays must use wss://."],
    ["wss://user:secret@relay.example", "Relay URLs cannot include credentials."],
    ["wss://relay.example/#fragment", "Relay URLs cannot include a fragment."]
  ])("rejects invalid custom URL %j", (value, message) => {
    expect(validateCustomRelayUrl(value)).toBe(message);
  });

  it("accepts secure relay URLs with ports, paths, and query strings", () => {
    expect(validateCustomRelayUrl("wss://relay.example:9443/socket?region=local"))
      .toBeNull();
  });

  it("hides the custom relay control outside the environments that list it", () => {
    expect(CUSTOM_RELAY_CONTROL_APP_ENVS).toEqual(["dev"]);
    expect(isCustomRelayControlEnabled("dev")).toBe(true);
    expect(isCustomRelayControlEnabled("staging")).toBe(false);
    expect(isCustomRelayControlEnabled("prod")).toBe(false);
    expect(isCustomRelayControlEnabled(undefined)).toBe(false);
    expect(isCustomRelayControlEnabled(null)).toBe(false);
    expect(isCustomRelayControlEnabled("  ")).toBe(false);
  });

  it("ignores a stored endpoint where the control is hidden and honors it where it is shown", () => {
    expect(resolveActiveCustomRelayUrl("wss://relay.home.example", false)).toBeNull();
    expect(resolveActiveCustomRelayUrl(" wss://relay.home.example ", true))
      .toBe("wss://relay.home.example");

    // Shipped builds fall back to the environment default rather than routing
    // through an endpoint their user has no way to see or reset.
    expect(resolveRelayUrl({}, {
      appEnv: "prod",
      customRelayUrl: "wss://relay.home.example",
      extraRelayUrl: "wss://relay.kanna.build"
    })).toBe("wss://relay.kanna.build");
    expect(resolveRelayUrl({}, {
      appEnv: "staging",
      customRelayUrl: "wss://relay.home.example",
      extraRelayUrl: "wss://relay-staging.kanna.build"
    })).toBe("wss://relay-staging.kanna.build");
    expect(resolveRelayUrl({}, {
      appEnv: "dev",
      customRelayUrl: "wss://relay.home.example",
      extraRelayUrl: "wss://relay-staging.kanna.build"
    })).toBe("wss://relay.home.example");
  });

  it("drops invalid persisted overrides instead of preventing startup", () => {
    expect(normalizePersistedCustomRelayUrl("ws://relay.example")).toBeNull();
    expect(normalizePersistedCustomRelayUrl(42)).toBeNull();
    expect(normalizePersistedCustomRelayUrl(" wss://relay.example "))
      .toBe("wss://relay.example");
  });
});
