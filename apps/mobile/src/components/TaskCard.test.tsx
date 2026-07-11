import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let TaskCard: typeof import("./TaskCard").TaskCard | null = null;

beforeAll(async () => {
  TaskCard = (await import("./TaskCard")).TaskCard;
});

describe("TaskCard", () => {
  it("keeps the automation id separate from its human-readable accessibility label", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");

    const tree = TaskCard({
      isRecentView: true,
      repoName: "Kanna",
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Repair cloud task sync",
        stage: "review"
      },
      onPress: vi.fn()
    }) as { props: Record<string, unknown> };

    expect(tree.props.testID).toBe("mobile.task-row.task-1");
    expect(tree.props.accessibilityLabel).toContain("Repair cloud task sync");
    expect(tree.props.accessibilityLabel).not.toBe("mobile.task-row.task-1");
  });
});
