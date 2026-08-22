import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoDirectoryListing, RepoFileRange } from "../lib/api/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { injectedScripts } = vi.hoisted(() => ({ injectedScripts: [] as string[] }));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    ActivityIndicator: "ActivityIndicator",
    FlatList: (props: Record<string, unknown>) => ReactModule.createElement("FlatList", props),
    Modal: "Modal",
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

let mounted: ReactTestRenderer | null = null;
afterEach(async () => {
  vi.useRealTimers();
  injectedScripts.length = 0;
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

describe("RepoExplorer request ownership", () => {
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
