import { describe, expect, it } from "vitest";
import type { RepoCommandCatalog } from "../lib/api/types";
import { buildRepoCommandSections } from "./repoCommandPresentation";

const catalog: RepoCommandCatalog = {
  repoId: "repo-1",
  revision: "catalog-v1",
  commands: [
    {
      id: "custom:merge-master",
      label: "Merge Master",
      description: "Merge ready pull requests",
      group: "automation"
    },
    {
      id: "custom:ship",
      label: "Ship",
      description: "Release this repository",
      group: "automation"
    },
    {
      id: "factory:create-agent",
      label: "Create Agent",
      description: "Create a new agent definition",
      group: "configure"
    }
  ]
};

describe("buildRepoCommandSections", () => {
  it("groups repository automations before configuration commands", () => {
    const sections = buildRepoCommandSections(catalog, "");

    expect(sections.map((section) => section.title)).toEqual([
      "Automations",
      "Configure Repository"
    ]);
    expect(sections[0]?.commands.map((command) => command.id)).toEqual([
      "custom:merge-master",
      "custom:ship"
    ]);
  });

  it("searches labels, descriptions, and command ids locally", () => {
    expect(buildRepoCommandSections(catalog, "release")[0]?.commands).toEqual([
      expect.objectContaining({ id: "custom:ship" })
    ]);
    expect(buildRepoCommandSections(catalog, "create-agent")[0]).toMatchObject({
      title: "Configure Repository",
      commands: [expect.objectContaining({ id: "factory:create-agent" })]
    });
  });
});
