// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import { createPipelineApi } from "./pipeline";
import type { StoreContext } from "./state";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
  }),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

function makeApi() {
  const context = {
    state: {
      pipelineCache: new Map(),
      agentCache: new Map(),
    },
  } as unknown as StoreContext;
  return createPipelineApi(context);
}

function remoteAgent(prompt: string) {
  return {
    name: "review",
    description: "Reviews branches",
    agent_provider: ["codex" as const, "claude" as const],
    model: "sonnet",
    prompt,
  };
}

function remotePipeline(stageName: string) {
  return {
    name: "qa",
    stages: [{
      name: stageName,
      policy: { transition: "manual" as const },
    }],
  };
}

describe("revisioned server definitions", () => {
  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    invokeMock.mockReset();
  });

  it("loads agents by repo ID without reading checkout definition files", async () => {
    const fetchRepoAgentDefinition = vi.fn(async () => ({
      revision: "rev-1",
      definition: remoteAgent("REMOTE_AGENT"),
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoAgentDefinition });

    await expect(makeApi().loadAgent("repo-1", "review@strict")).resolves.toMatchObject({
      prompt: "REMOTE_AGENT",
      model: "sonnet",
    });

    expect(fetchRepoAgentDefinition).toHaveBeenCalledWith("repo-1", "review@strict");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reuses an agent object for the same revision and replaces it when origin advances", async () => {
    const fetchRepoAgentDefinition = vi.fn()
      .mockResolvedValueOnce({ revision: "rev-1", definition: remoteAgent("REMOTE_AGENT") })
      .mockResolvedValueOnce({ revision: "rev-1", definition: remoteAgent("IGNORED_SAME_REVISION") })
      .mockResolvedValueOnce({ revision: "rev-2", definition: remoteAgent("REMOTE_AGENT_V2") });
    updateDesktopServerClientHandlersForTests({ fetchRepoAgentDefinition });

    const api = makeApi();
    const first = await api.loadAgent("repo-1", "review");
    const same = await api.loadAgent("repo-1", "review");
    const changed = await api.loadAgent("repo-1", "review");

    expect(fetchRepoAgentDefinition).toHaveBeenCalledTimes(3);
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.prompt).toBe("REMOTE_AGENT_V2");
  });

  it("reuses a pipeline object for the same revision and replaces it when origin advances", async () => {
    const fetchRepoPipelineDefinition = vi.fn()
      .mockResolvedValueOnce({ revision: "rev-1", definition: remotePipeline("review") })
      .mockResolvedValueOnce({ revision: "rev-1", definition: remotePipeline("ignored") })
      .mockResolvedValueOnce({ revision: "rev-2", definition: remotePipeline("pr") });
    updateDesktopServerClientHandlersForTests({ fetchRepoPipelineDefinition });

    const api = makeApi();
    const first = await api.loadPipeline("repo-1", "qa");
    const same = await api.loadPipeline("repo-1", "qa");
    const changed = await api.loadPipeline("repo-1", "qa");

    expect(fetchRepoPipelineDefinition).toHaveBeenCalledTimes(3);
    expect(fetchRepoPipelineDefinition).toHaveBeenCalledWith("repo-1", "qa");
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.stages[0]?.name).toBe("pr");
  });

  it("reuses bundled-only definitions while still checking the server on every load", async () => {
    const fetchRepoAgentDefinition = vi.fn()
      .mockResolvedValueOnce({ revision: null, definition: remoteAgent("BUNDLED_AGENT") })
      .mockResolvedValueOnce({ revision: null, definition: remoteAgent("IGNORED_SAME_REVISION") });
    updateDesktopServerClientHandlersForTests({ fetchRepoAgentDefinition });

    const api = makeApi();
    const first = await api.loadAgent("repo-1", "review");
    const same = await api.loadAgent("repo-1", "review");

    expect(fetchRepoAgentDefinition).toHaveBeenCalledTimes(2);
    expect(same).toBe(first);
    expect(same.prompt).toBe("BUNDLED_AGENT");
  });

  it("propagates server definition errors without falling back to local resources", async () => {
    const fetchRepoAgentDefinition = vi.fn(async () => {
      throw new Error("invalid remote agent at origin/main");
    });
    const fetchRepoPipelineDefinition = vi.fn(async () => {
      throw new Error("invalid remote pipeline at origin/main");
    });
    updateDesktopServerClientHandlersForTests({
      fetchRepoAgentDefinition,
      fetchRepoPipelineDefinition,
    });

    const api = makeApi();
    await expect(api.loadAgent("repo-1", "review")).rejects.toThrow("invalid remote agent");
    await expect(api.loadPipeline("repo-1", "qa")).rejects.toThrow("invalid remote pipeline");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
