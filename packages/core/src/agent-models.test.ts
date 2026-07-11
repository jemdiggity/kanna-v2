import { describe, expect, it } from "vitest";
import { VALID_AGENT_PROVIDERS } from "./config/agent-providers.js";
import { AGENT_MODELS, agentModelsFor } from "./agent-models.js";

describe("agentModelsFor", () => {
  it("uses Claude models only when no provider is selected", () => {
    expect(agentModelsFor(undefined)).toEqual(AGENT_MODELS.claude);
  });

  it("returns no models for known providers without a verified catalog", () => {
    const providersWithoutCatalog = VALID_AGENT_PROVIDERS.filter(
      (provider) => !(provider in AGENT_MODELS),
    );

    for (const provider of providersWithoutCatalog) {
      expect(agentModelsFor(provider), provider).toEqual([]);
    }
  });
});
