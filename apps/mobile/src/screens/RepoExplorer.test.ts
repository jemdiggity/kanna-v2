import { describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { createLoiterRangeLoader } from "./repoExplorerLoiter";
import { buildViewerDocument, readCompleteRange } from "./repoExplorerViewer";

describe("repository explorer loiter loading", () => {
  it("does not fetch while the viewport is flinging and caches a settled range", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const loader = createLoiterRangeLoader(load, 300);
    loader.observe(0);
    vi.advanceTimersByTime(100);
    loader.observe(200);
    vi.advanceTimersByTime(100);
    loader.observe(500);
    vi.advanceTimersByTime(299);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledWith(500);
    loader.observe(500);
    vi.advanceTimersByTime(300);
    expect(load).toHaveBeenCalledTimes(1);
    loader.observe(900);
    vi.advanceTimersByTime(300);
    loader.observe(500);
    vi.advanceTimersByTime(300);
    expect(load).toHaveBeenCalledTimes(2);
    loader.dispose();
    vi.useRealTimers();
  });

  it("keeps a settled oversized-line load bounded and preserves explicit continuation bytes", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce({ path:"huge.txt",startLine:0,startByte:0,lines:["abc"],nextLine:0,nextByte:3,totalLines:1,totalBytes:6,binary:false,metadataOnly:false })
      .mockResolvedValueOnce({ path:"huge.txt",startLine:0,startByte:3,lines:["def"],nextLine:null,nextByte:null,totalLines:1,totalBytes:6,binary:false,metadataOnly:false });
    const first = await readCompleteRange(readFile, "huge.txt", 0, 50, false);
    expect(first.lines).toEqual(["abc"]);
    expect(first.nextByte).toBe(3);
    expect(readFile).toHaveBeenCalledTimes(1);
    const second = await readCompleteRange(readFile, "huge.txt", first.nextLine ?? 0, 50, false, first.nextByte ?? 0);
    expect(first.lines[0] + second.lines[0]).toBe("abcdef");
    expect(readFile).toHaveBeenNthCalledWith(2, "huge.txt", 0, 50, false, 3);
  });

  it("builds a bounded absolute-line window for a very large file", () => {
    const document = buildViewerDocument("src/huge.ts", {
      path:"src/huge.ts",startLine:0,startByte:0,lines:Array.from({length:50},()=>"12"),nextLine:50,nextByte:null,totalLines:2_000_000,totalBytes:24_000_000,binary:false,metadataOnly:true,
    });
    expect(document).toContain("windowSize=90");
    expect(document).toContain("const end=Math.min(total,start+windowSize)");
    expect(document).not.toContain("for(let i=0;i<total;i++)");
    expect(document).toContain("row.dataset.line=i");
    expect(document).toContain("window.setNativeScrollY=");
    expect(document).toContain("content=new Map()");
  });

  it("uses the native viewport offset for the fallback reference and button label", () => {
    const { window, messages } = viewer("src/huge.ts");
    Object.defineProperty(window, "scrollY", { configurable:true, value:0 });
    window.eval("setNativeScrollY(2000000)");

    expect(window.document.querySelector("#insert")?.textContent).toBe("Insert reference (L100001)");
    window.eval("insertRef()");
    expect(messages.at(-1)).toEqual({type:"insert",reference:"src/huge.ts:100001"});
  });

  it("selects a line-number range, previews it, prefers it over the viewport, and clears it", () => {
    const { window, messages } = viewer("src/huge.ts");
    const insert = () => window.document.querySelector("#insert")?.textContent;
    const number = (line: number) => window.document.querySelector<HTMLElement>(`[data-line="${line - 1}"] .num`);

    number(5)?.click();
    expect(window.document.querySelector('[data-line="4"]')?.classList.contains("picked")).toBe(true);
    expect(insert()).toBe("Insert reference (L5)");

    number(9)?.click();
    expect(window.document.querySelectorAll(".line.picked")).toHaveLength(5);
    expect(insert()).toBe("Insert reference (L5–L9)");
    window.eval("setNativeScrollY(400)");
    expect(insert()).toBe("Insert reference (L5–L9)");
    window.eval("insertRef()");
    expect(messages.at(-1)).toEqual({type:"insert",reference:"src/huge.ts:5-9"});

    window.eval("setNativeScrollY(0)");
    number(9)?.click();
    expect(window.document.querySelectorAll(".line.picked")).toHaveLength(0);
    expect(insert()).toBe("Insert reference (L1)");
    window.eval("insertRef()");
    expect(messages.at(-1)).toEqual({type:"insert",reference:"src/huge.ts:1"});
  });

  it("keeps the live DOM bounded, reuses loitered content, and inserts an absolute selected line", () => {
    const html = buildViewerDocument("src/huge.ts", {
      path:"src/huge.ts",startLine:0,startByte:0,lines:Array.from({length:50},()=>"12"),nextLine:50,nextByte:null,totalLines:2_000_000,totalBytes:24_000_000,binary:false,metadataOnly:true,
    });
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (!script) throw new Error("viewer script missing");
    const window = new Window();
    const messages: Array<{type:string;reference?:string}> = [];
    (window as unknown as {ReactNativeWebView:{postMessage(value:string):void}}).ReactNativeWebView = {
      postMessage(value) { messages.push(JSON.parse(value) as {type:string;reference?:string}); },
    };
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ""));
    window.eval(script);
    expect(window.document.querySelectorAll(".line")).toHaveLength(90);

    Object.defineProperty(window, "scrollY", { configurable:true, value:2_000_000 });
    window.dispatchEvent(new window.Event("scroll"));
    expect(window.document.querySelectorAll(".line")).toHaveLength(90);
    window.eval("applyContent([{number:100000,text:'selected',html:'selected'}],0,null,null)");
    expect(window.document.querySelector('[data-line="100000"] .code')?.textContent).toBe("selected");
    window.eval("applyContent([{number:100001,text:'abc',html:'abc'}],0,100001,3)");
    window.eval("applyContent([{number:100001,text:'def',html:'def'}],3,null,null)");
    window.eval("applyContent([{number:100001,text:'def',html:'def'}],3,null,null)");
    expect(window.document.querySelector('[data-line="100001"] .code')?.textContent).toBe("abcdef");
    Object.defineProperty(window, "scrollY", { configurable:true, value:0 });
    window.dispatchEvent(new window.Event("scroll"));
    Object.defineProperty(window, "scrollY", { configurable:true, value:2_000_000 });
    window.dispatchEvent(new window.Event("scroll"));
    expect(window.document.querySelector('[data-line="100000"] .code')?.textContent).toBe("selected");

    const code = window.document.querySelector('[data-line="100000"] .code');
    if (!code) throw new Error("selected line missing");
    const range = window.document.createRange();
    range.selectNodeContents(code);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const quote = window.document.querySelector<HTMLInputElement>("#quote");
    if (quote) quote.checked = true;
    window.eval("updateInsertLabel()");
    expect(window.document.querySelector("#insert")?.textContent).toBe("Insert reference (L100001)");
    window.eval("captureTextSelection()");
    window.getSelection()?.removeAllRanges();
    window.eval("insertRef()");
    expect(messages.at(-1)).toEqual({type:"insert",reference:"src/huge.ts:100001\n> selected"});
  });
});

function viewer(path: string) {
  const html = buildViewerDocument(path, {
    path,startLine:0,startByte:0,lines:Array.from({length:50},()=>"12"),nextLine:50,nextByte:null,totalLines:2_000_000,totalBytes:24_000_000,binary:false,metadataOnly:true,
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("viewer script missing");
  const window = new Window();
  const messages: Array<{type:string;reference?:string}> = [];
  (window as unknown as {ReactNativeWebView:{postMessage(value:string):void}}).ReactNativeWebView = {
    postMessage(value) { messages.push(JSON.parse(value) as {type:string;reference?:string}); },
  };
  window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ""));
  window.eval(script);
  return { window, messages };
}
