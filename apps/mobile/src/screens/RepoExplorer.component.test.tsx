import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoDirectoryListing, RepoFileRange } from "../lib/api/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { injectedScripts } = vi.hoisted(() => ({ injectedScripts: [] as string[] }));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  class AnimatedValue {
    value: number;
    constructor(value: number) { this.value = value; }
    setValue(value: number) { this.value = value; }
    stopAnimation(callback?: (value: number) => void) { callback?.(this.value); }
    interpolate() { return this; }
  }
  const animation = (value: AnimatedValue, config: { toValue: number }) => ({
    start(callback?: (result: { finished: boolean }) => void) {
      value.setValue(config.toValue);
      callback?.({ finished: true });
    }
  });
  return {
    ActivityIndicator: "ActivityIndicator",
    Animated: {
      Value: AnimatedValue,
      View: (props: Record<string, unknown>) => ReactModule.createElement("AnimatedView", props),
      spring: animation,
      timing: animation
    },
    AppState: {
      addEventListener: () => ({ remove() {} })
    },
    FlatList: (props: Record<string, unknown>) => ReactModule.createElement("FlatList", props),
    Modal: "Modal",
    PanResponder: {
      create: (handlers: Record<string, unknown>) => ({ panHandlers: handlers })
    },
    Pressable: "Pressable",
    RefreshControl: "RefreshControl",
    SafeAreaView: "SafeAreaView",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: "Text",
    TextInput: "TextInput",
    View: "View"
  };
});

vi.mock("react-native-webview", async () => {
  const ReactModule = await import("react");
  return {
    WebView: ReactModule.forwardRef(function WebView(props: Record<string, unknown>, ref: React.ForwardedRef<{injectJavaScript(script:string):void}>) {
      ReactModule.useImperativeHandle(ref, () => ({ injectJavaScript: (script:string) => { injectedScripts.push(script); } }));
      return ReactModule.createElement("WebView", props);
    })
  };
});

import { LoiterFileViewer, RepoExplorer } from "./RepoExplorer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function listing(entries: RepoDirectoryListing["entries"], nextOffset: number | null): RepoDirectoryListing {
  return { path: "", entries, offset: 0, nextOffset, totalEntries: entries.length };
}

function range(startLine: number, metadataOnly: boolean): RepoFileRange {
  return { path:"src/file.ts",startLine,startByte:0,lines:metadataOnly?["4"]:[`line-${startLine}`],nextLine:null,nextByte:null,totalLines:300,totalBytes:1200,binary:false,metadataOnly };
}

function outgoingOffset(tree: ReactTestRenderer): number {
  const outgoing = tree.root.findByProps({ testID: "mobile.repo-explorer.outgoing-surface" });
  return outgoing.props.style[1].transform[0].translateX.value;
}

let mounted: ReactTestRenderer | null = null;
afterEach(async () => {
  vi.useRealTimers();
  injectedScripts.length = 0;
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

describe("RepoExplorer request ownership", () => {
  it("owns edge gestures at the full-screen container below a short list", async () => {
    const listDirectory = vi.fn((path: string) => Promise.resolve(listing(path === "src"
      ? [{ name: "only.ts", path: "src/only.ts", isDir: false, size: 4 }]
      : [{ name: "src", path: "src", isDir: true }], null)));
    await act(async () => {
      mounted = create(<RepoExplorer title="Files" listDirectory={listDirectory} readFile={vi.fn()} onInsertReference={vi.fn()} onClose={vi.fn()} />);
    });
    const surface = mounted.root.findByProps({ testID: "mobile.repo-explorer.navigation-surface" });
    const directorySurface = mounted.root.findByProps({ testID: "mobile.repo-explorer.directory-gesture-surface" });
    const unavailableForwardGesture = { dx: -100, dy: 2, vx: -0.8, x0: 389, y0: 700 };
    expect(surface.props.onMoveShouldSetPanResponderCapture({}, unavailableForwardGesture)).toBe(true);
    expect(directorySurface.props.onStartShouldSetPanResponderCapture).toBeUndefined();
    expect(surface.props.onStartShouldSetPanResponderCapture({ nativeEvent: { pageX: 389 } })).toBe(true);
    await act(async () => { surface.props.onPanResponderRelease({}, unavailableForwardGesture); });
    expect(mounted.root.findAllByProps({ testID: "mobile.repo-explorer.incoming-page" })).toHaveLength(0);
    expect(outgoingOffset(mounted)).toBe(0);

    const rootList = mounted.root.findByType("FlatList");
    const src = rootList.props.data[0];
    await act(async () => { rootList.props.renderItem({ item: src }).props.onPress(); });

    const currentPage = mounted.root.findByProps({ testID: "mobile.repo-explorer.current-page" });
    expect(currentPage.props.onMoveShouldSetPanResponderCapture).toBeUndefined();
    const blankAreaGesture = { dx: 100, dy: 2, vx: 0.2, x0: 1, y0: 700 };
    await act(async () => {
      expect(surface.props.onMoveShouldSetPanResponderCapture({}, blankAreaGesture)).toBe(true);
      surface.props.onPanResponderMove({}, blankAreaGesture);
    });
    const incoming = mounted.root.findByProps({ testID: "mobile.repo-explorer.incoming-page" });
    expect(incoming.findByType("FlatList").props.data.map((entry: { path: string }) => entry.path)).toEqual(["src"]);

    await act(async () => { surface.props.onPanResponderRelease({}, blankAreaGesture); });
    expect(mounted.root.findByType("FlatList").props.data.map((entry: { path: string }) => entry.path)).toEqual(["src"]);

    const root = mounted.root.findByType("FlatList");
    await act(async () => { root.props.renderItem({ item: root.props.data[0] }).props.onPress(); });
    const cancelledGesture = { ...blankAreaGesture, dx: 30, vx: 0.1 };
    await act(async () => {
      expect(surface.props.onMoveShouldSetPanResponderCapture({}, cancelledGesture)).toBe(true);
      surface.props.onPanResponderMove({}, cancelledGesture);
      surface.props.onPanResponderRelease({}, cancelledGesture);
    });
    expect(mounted.root.findAllByProps({ testID: "mobile.repo-explorer.incoming-page" })).toHaveLength(0);
    expect(mounted.root.findByType("FlatList").props.data.map((entry: { path: string }) => entry.path)).toEqual(["src/only.ts"]);
    expect(outgoingOffset(mounted)).toBe(0);

    for (const terminalHandler of ["onPanResponderTerminate", "onPanResponderReject"] as const) {
      await act(async () => {
        expect(surface.props.onMoveShouldSetPanResponderCapture({}, cancelledGesture)).toBe(true);
        surface.props.onPanResponderMove({}, cancelledGesture);
        surface.props[terminalHandler]({}, cancelledGesture);
      });
      expect(mounted.root.findAllByProps({ testID: "mobile.repo-explorer.incoming-page" })).toHaveLength(0);
      expect(outgoingOffset(mounted)).toBe(0);
    }
  });

  it("captures preview edge swipes before the WebView while leaving mid-screen pans alone", async () => {
    const listDirectory = vi.fn((path: string) => Promise.resolve(listing(path === "src"
      ? [{ name: "file.ts", path: "src/file.ts", isDir: false, size: 4 }]
      : [{ name: "src", path: "src", isDir: true }], null)));
    await act(async () => {
      mounted = create(<RepoExplorer title="Files" listDirectory={listDirectory} readFile={() => Promise.resolve(range(0, true))} onInsertReference={vi.fn()} onClose={vi.fn()} />);
    });
    const pressEntry = async (path: string) => {
      const list = mounted?.root.findByType("FlatList");
      const item = list?.props.data.find((entry: { path: string }) => entry.path === path);
      await act(async () => { list?.props.renderItem({ item }).props.onPress(); });
    };
    await pressEntry("src");
    await pressEntry("src/file.ts");

    const previewSurface = mounted.root.findByProps({ testID: "mobile.repo-explorer.file-preview-gesture-surface" });
    expect(previewSurface.props.onStartShouldSetPanResponderCapture).toBeUndefined();
    const surface = mounted.root.findByProps({ testID: "mobile.repo-explorer.navigation-surface" });
    const edgeGesture = { dx: 100, dy: 2, vx: 0.2, x0: 1, y0: 400 };
    await act(async () => {
      expect(surface.props.onStartShouldSetPanResponderCapture({ nativeEvent: { pageX: 200 } })).toBe(false);
      expect(surface.props.onStartShouldSetPanResponderCapture({ nativeEvent: { pageX: 1 } })).toBe(true);
      surface.props.onPanResponderMove({}, edgeGesture);
    });
    const incoming = mounted.root.findByProps({ testID: "mobile.repo-explorer.incoming-page" });
    expect(incoming.findByType("FlatList").props.data.map((entry: { path: string }) => entry.path)).toEqual(["src/file.ts"]);

    await act(async () => { surface.props.onPanResponderRelease({}, edgeGesture); });
    expect(mounted.root.findAllByType("WebView")).toHaveLength(0);
    expect(mounted.root.findByType("FlatList").props.data.map((entry: { path: string }) => entry.path)).toEqual(["src/file.ts"]);
    expect(outgoingOffset(mounted)).toBe(0);
  });

  it("puts header Back destinations in forward history for an edge swipe", async () => {
    const listDirectory = vi.fn((path: string) => Promise.resolve(listing(path === "src"
      ? [{ name: "file.ts", path: "src/file.ts", isDir: false, size: 4 }]
      : [{ name: "src", path: "src", isDir: true }], null)));
    const readFile = vi.fn(() => Promise.resolve(range(0, true)));
    await act(async () => {
      mounted = create(<RepoExplorer title="Files" listDirectory={listDirectory} readFile={readFile} onInsertReference={vi.fn()} onClose={vi.fn()} />);
    });
    const pressEntry = async (path: string) => {
      const list = mounted?.root.findByType("FlatList");
      const item = list?.props.data.find((entry: { path: string }) => entry.path === path);
      await act(async () => { list?.props.renderItem({ item }).props.onPress(); });
    };
    await pressEntry("src");
    await pressEntry("src/file.ts");
    expect(mounted?.root.findAllByType("WebView")).toHaveLength(1);

    await act(async () => {
      mounted?.root.findByProps({ testID: "mobile.repo-explorer.back" }).props.onPress();
    });
    expect(mounted?.root.findAllByType("WebView")).toHaveLength(0);
    const surface = mounted?.root.findByProps({ testID: "mobile.repo-explorer.navigation-surface" });
    expect(surface?.props.onMoveShouldSetPanResponderCapture({}, { dx: -100, dy: 2, vx: -0.2, x0: 200 })).toBe(false);
    expect(surface?.props.onMoveShouldSetPanResponderCapture({}, { dx: -20, dy: 100, vx: -0.2, x0: 389 })).toBe(false);
    const gesture = { dx: -100, dy: 2, vx: -0.2, x0: 389 };
    await act(async () => {
      expect(surface?.props.onMoveShouldSetPanResponderCapture({}, gesture)).toBe(true);
      surface?.props.onPanResponderMove({}, gesture);
    });
    expect(mounted?.root.findByProps({ testID: "mobile.repo-explorer.incoming-page" })).toBeDefined();
    expect(mounted?.root.findByProps({ testID: "mobile.repo-explorer.incoming-surface" })).toBeDefined();
    expect(mounted?.root.findByProps({ testID: "mobile.repo-explorer.outgoing-surface" })).toBeDefined();
    await act(async () => { surface?.props.onPanResponderRelease({}, gesture); });
    expect(mounted?.root.findAllByType("WebView")).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("drops stale and duplicate directory pages after the listing scope changes", async () => {
    const oldNext = deferred<RepoDirectoryListing>();
    const listDirectory = vi.fn((path: string, showAll: boolean, offset: number, filter?: string) => {
      if (filter === "new") return Promise.resolve(listing([{name:"new.ts",path:"new.ts",isDir:false,size:1}], null));
      if (offset === 60) return oldNext.promise;
      return Promise.resolve(listing([{name:"old.ts",path:"old.ts",isDir:false,size:1}], 60));
    });
    await act(async () => {
      mounted = create(<RepoExplorer title="Files" listDirectory={listDirectory} readFile={vi.fn()} onInsertReference={vi.fn()} onClose={vi.fn()} />);
    });
    const list = () => mounted?.root.findByType("FlatList");
    await act(async () => {
      list()?.props.onEndReached();
      list()?.props.onEndReached();
    });
    expect(listDirectory.mock.calls.filter((call) => call[2] === 60)).toHaveLength(1);
    await act(async () => { mounted?.root.findByType("TextInput").props.onChangeText("new"); });
    await act(async () => { oldNext.resolve(listing([{name:"stale.ts",path:"stale.ts",isDir:false,size:1}], 120)); });
    expect(list()?.props.data.map((entry: {name:string}) => entry.name)).toEqual(["new.ts"]);
    const calls = listDirectory.mock.calls.length;
    await act(async () => { list()?.props.onEndReached(); });
    expect(listDirectory).toHaveBeenCalledTimes(calls);
  });

  it("preserves metadata and content caches across an equivalent callback rerender", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn((path: string, startLine: number, lineCount: number, metadataOnly = false) => Promise.resolve(range(startLine, metadataOnly)));
    const callback = () => (path: string, startLine: number, lineCount: number, metadataOnly?: boolean, startByte?: number) => underlying(path,startLine,lineCount,metadataOnly,startByte);
    await act(async () => { mounted = create(<LoiterFileViewer path="src/file.ts" readFile={callback()} onInsertReference={vi.fn()} />); });
    const sendViewport = async (start: number) => {
      await act(async () => {
        mounted?.root.findByType("WebView").props.onMessage({nativeEvent:{data:JSON.stringify({type:"viewport",start})}});
        vi.advanceTimersByTime(300);
      });
    };
    await sendViewport(0);
    expect(underlying.mock.calls.filter((call) => call[3] === true && call[1] === 0)).toHaveLength(1);
    expect(underlying.mock.calls.filter((call) => call[3] === false && call[1] === 0)).toHaveLength(1);
    await act(async () => { mounted?.update(<LoiterFileViewer path="src/file.ts" readFile={callback()} onInsertReference={vi.fn()} />); });
    await sendViewport(100);
    await sendViewport(0);
    expect(underlying.mock.calls.filter((call) => call[3] === true && call[1] === 0)).toHaveLength(1);
    expect(underlying.mock.calls.filter((call) => call[3] === false && call[1] === 0)).toHaveLength(1);
  });

  it("forwards the native WebView scroll offset to the viewer document", async () => {
    await act(async () => { mounted = create(<LoiterFileViewer path="src/file.ts" readFile={(path,startLine,lineCount,metadataOnly=false)=>Promise.resolve(range(startLine,metadataOnly))} onInsertReference={vi.fn()} />); });
    await act(async () => {
      mounted?.root.findByType("WebView").props.onScroll({nativeEvent:{contentOffset:{y:2380}}});
    });
    expect(injectedScripts.at(-1)).toBe("window.setNativeScrollY?.(2380);true;");
  });
});
