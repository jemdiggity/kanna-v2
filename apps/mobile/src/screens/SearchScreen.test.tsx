import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  focus: vi.fn()
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    ScrollView: "ScrollView",
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
    TextInput: ReactModule.forwardRef(function TextInput(
      props: Record<string, unknown>,
      ref: import("react").ForwardedRef<{ focus(): void }>
    ) {
      ReactModule.useImperativeHandle(ref, () => ({ focus: harness.focus }));
      return ReactModule.createElement("TextInput", props);
    }),
    View: "View"
  };
});

vi.mock("../components/TaskList", () => ({ TaskList: "TaskList" }));

import { SearchScreen } from "./SearchScreen";

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.focus.mockReset();
});

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted = null;
  }
});

describe("SearchScreen", () => {
  it("names task IDs as searchable and keeps result IDs visible through TaskList", async () => {
    const result = {
      id: "eef65d54",
      repoId: "repo-1",
      title: "Unrelated title",
      stage: "in progress"
    };

    await act(async () => {
      mounted = create(
        <SearchScreen
          focusRequestKey={0}
          query="eef65"
          results={[result]}
          onChangeQuery={vi.fn()}
          onOpenTask={vi.fn()}
        />
      );
    });

    const text = mounted.root
      .findAllByType("Text")
      .map((node) => node.children.join(""))
      .join(" ");
    expect(text).toContain("task ID");
    expect(mounted.root.findByType("TaskList").props.taskSlots[0]).toMatchObject({
      state: "ready",
      taskId: "eef65d54"
    });
  });

  it("does not focus the query input without a focus request", async () => {
    await act(async () => {
      mounted = create(
        <SearchScreen
          focusRequestKey={0}
          query=""
          results={[]}
          onChangeQuery={vi.fn()}
          onOpenTask={vi.fn()}
        />
      );
    });

    expect(harness.focus).not.toHaveBeenCalled();
  });

  it("focuses the query input for each new focus request", async () => {
    const props = {
      focusRequestKey: 1,
      query: "existing query",
      results: [],
      onChangeQuery: vi.fn(),
      onOpenTask: vi.fn()
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SearchScreen {...props} />);
      mounted = renderer;
    });

    expect(harness.focus).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("TextInput").props.value).toBe("existing query");

    await act(async () => {
      renderer.update(<SearchScreen {...props} />);
    });
    expect(harness.focus).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<SearchScreen {...props} focusRequestKey={2} />);
    });
    expect(harness.focus).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("TextInput").props.value).toBe("existing query");
  });
});
