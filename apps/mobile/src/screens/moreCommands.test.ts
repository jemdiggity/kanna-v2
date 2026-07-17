import { describe, expect, it } from "vitest";
import { buildMoreCommandPalette, buildMoreCommandSections } from "./moreCommands";

describe("buildMoreCommandSections", () => {
  it("builds compact workspace and task command sections", () => {
    const sections = buildMoreCommandSections({
      selectedTask: {
        id: "task-1",
        repoId: "repo-1",
        title: "Review mobile shell",
        stage: "pr",
        waitingPromptSnippet: "Agent says the branch is ready for review."
      }
    });

    expect(sections[0]).toMatchObject({
      title: "Workspace",
      headline: "Commands"
    });
    expect(sections[1]?.actions.map((action) => action.id)).toEqual([
      "advance-stage",
      "merge-agent",
      "close-task"
    ]);
    expect(sections[1]).toMatchObject({
      title: "Task",
      headline: "Review mobile shell"
    });
    expect(sections).toHaveLength(2);
  });

  it("omits task actions when no task is selected", () => {
    const sections = buildMoreCommandSections({
      selectedTask: null
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      title: "Workspace",
      headline: "Commands"
    });
    expect(sections[0]?.actions.map((action) => action.id)).toEqual([
      "refresh",
      "compose"
    ]);
  });

  it("builds a searchable command palette and filters matching actions", () => {
    const entries = buildMoreCommandPalette(
      {
        selectedTask: {
          id: "task-1",
          repoId: "repo-1",
          title: "Review mobile shell",
          stage: "pr",
          waitingPromptSnippet: "Agent says the branch is ready for review."
        }
      },
      "merge"
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "merge-agent",
      title: "Run Merge Agent",
      sectionTitle: "Task",
      sectionHeadline: "Review mobile shell"
    });
  });

  it("keeps only global commands in the palette when no task is selected", () => {
    const entries = buildMoreCommandPalette(
      {
        selectedTask: null
      },
      ""
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "refresh",
      "compose"
    ]);
  });

  it("labels the refresh command while refresh is in progress", () => {
    const entries = buildMoreCommandPalette(
      {
        refreshStatus: "refreshing",
        selectedTask: null
      },
      ""
    );

    expect(entries[0]).toMatchObject({
      id: "refresh",
      title: "Refreshing...",
      copy: "Reloading machines, repos, and recent tasks."
    });
  });
});
