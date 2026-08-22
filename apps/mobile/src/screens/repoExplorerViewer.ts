import type { RepoFileRange } from "../lib/api/types";

export interface RepoRangeReader {
  (path:string,startLine:number,lineCount:number,metadataOnly?:boolean,startByte?:number):Promise<RepoFileRange>;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/&/g,"\\u0026").replace(/</g,"\\u003c").replace(/>/g,"\\u003e");
}

/** Reads exactly one server-bounded range. A same-line `nextByte` is an
 * explicit continuation token; callers must not exhaust it automatically. */
export function readCompleteRange(readFile:RepoRangeReader,path:string,startLine:number,lineCount:number,metadataOnly:boolean,startByte=0):Promise<RepoFileRange>{
  return readFile(path,startLine,lineCount,metadataOnly,startByte);
}

export function buildViewerDocument(path:string,initial:RepoFileRange):string {
  const lengths=initial.lines.map(Number);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#08111e;color:#dce7f5;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}#bar{position:sticky;top:0;z-index:2;background:#101b2e;padding:8px;border-bottom:1px solid #263754}button{background:#28476d;color:white;border:0;border-radius:7px;padding:7px 10px}#more{display:none}#lines{position:relative;height:${initial.totalLines*20}px}.line{height:20px;white-space:pre;display:flex;position:absolute;left:0}.num{color:#5e7290;width:52px;text-align:right;padding-right:12px;user-select:none;-webkit-user-select:none}.line.picked{background:#17385d}.line.picked .num{color:#9fd1ff;font-weight:700}.code{min-width:max-content}.sk{height:10px;margin-top:5px;border-radius:4px;background:#1c2c46}.hljs-keyword,.hljs-selector-tag{color:#ff7ab2}.hljs-string,.hljs-attr{color:#a8cc8c}.hljs-number,.hljs-literal{color:#d2a8ff}.hljs-comment{color:#70819d}</style><div id="bar"><button id="insert" ontouchstart="captureTextSelection()" onmousedown="captureTextSelection()" onclick="insertRef()">Insert reference (L1)</button> <label><input id="quote" type="checkbox"> include selected text</label> <button id="more" onclick="loadMore()">Load more of long line</button></div><div id="lines"></div><script>const path=${scriptJson(path)},total=${initial.totalLines},windowSize=90,heights=new Map(${scriptJson(lengths.map((length,index)=>[index,length]))}),content=new Map(),loadedBytes=new Map(),encoder=new TextEncoder();const root=document.getElementById('lines'),more=document.getElementById('more'),insert=document.getElementById('insert');let windowStart=-1,pendingContinuation=null,nativeScrollY=null,pickedAnchor=null,pickedFocus=null,capturedTextSelection=null;
function visible(number,selector){return root.querySelector('[data-line="'+number+'"] '+selector)}
function pickedRange(){if(pickedAnchor===null||pickedFocus===null)return null;return {start:Math.min(pickedAnchor,pickedFocus),end:Math.max(pickedAnchor,pickedFocus)}}
function syncPickedRows(){const picked=pickedRange();root.querySelectorAll('.line').forEach(row=>{const number=Number(row.dataset.line);row.classList.toggle('picked',!!picked&&number>=picked.start&&number<=picked.end)})}
function render(start){start=Math.max(0,Math.min(Math.max(0,total-windowSize),start));if(start===windowStart)return;windowStart=start;root.replaceChildren();const end=Math.min(total,start+windowSize);for(let i=start;i<end;i++){const row=document.createElement('div');row.className='line';row.dataset.line=i;row.style.top=(i*20)+'px';const cached=content.get(i);row.innerHTML='<span class="num">'+(i+1)+'</span><span class="code">'+(cached??'<span class="sk" style="width:'+Math.max(24,Math.min(720,(heights.get(i)||18)*7))+'px"></span>')+'</span>';root.appendChild(row)}syncPickedRows()}
function effectiveScrollY(){return nativeScrollY??Math.max(0,window.scrollY||window.pageYOffset||document.documentElement.scrollTop||document.body.scrollTop||0)}
function viewportLine(){return Math.max(1,Math.min(Math.max(1,total),Math.floor(effectiveScrollY()/20)+1))}
function rowForNode(node){const element=node?.nodeType===1?node:node?.parentElement;return element?.closest('.line')||null}
function liveTextSelection(){const selection=getSelection(),text=selection?.toString()||'';if(!selection||!text||!selection.rangeCount)return null;const range=selection.getRangeAt(0),a=rowForNode(range.startContainer),b=rowForNode(range.endContainer);if(!a||!b)return null;const first=Number(a.dataset.line),last=Number(b.dataset.line);return {start:Math.min(first,last),end:Math.max(first,last),text}}
function chosenRange(){const textSelection=liveTextSelection();if(textSelection)return textSelection;const picked=pickedRange();if(picked)return picked;const line=viewportLine()-1;return {start:line,end:line}}
function updateInsertLabel(){const chosen=chosenRange(),start=chosen.start+1,end=chosen.end+1;insert.textContent='Insert reference (L'+start+(end===start?'':'–L'+end)+')'}
function request(){const start=Math.max(0,Math.floor(effectiveScrollY()/20)-10);render(start);updateInsertLabel();ReactNativeWebView.postMessage(JSON.stringify({type:'viewport',start}))}
window.setNativeScrollY=(value)=>{nativeScrollY=Math.max(0,Number(value)||0);request()};
addEventListener('scroll',request,{passive:true});addEventListener('selectionchange',updateInsertLabel);
root.addEventListener('click',event=>{const number=event.target.closest('.num');if(!number)return;const line=Number(number.parentElement.dataset.line),picked=pickedRange();if(picked&&line>=picked.start&&line<=picked.end){pickedAnchor=null;pickedFocus=null}else if(pickedAnchor===null){pickedAnchor=line;pickedFocus=line}else{pickedFocus=line}getSelection()?.removeAllRanges();syncPickedRows();updateInsertLabel()});
window.applyMetadata=(rows)=>rows.forEach(x=>{heights.set(x.number,x.length);const sk=visible(x.number,'.sk');if(sk)sk.style.width=Math.max(24,Math.min(720,x.length*7))+'px'});
window.applyContent=(rows,startByte,nextLine,nextByte)=>{rows.forEach((x,index)=>{const expected=loadedBytes.get(x.number)||0;if(index===0&&startByte>0&&expected!==startByte)return;const html=(index===0&&startByte>0?(content.get(x.number)||''):'')+(x.html||' ');content.set(x.number,html);loadedBytes.set(x.number,(index===0?startByte:0)+encoder.encode(x.text).length);const code=visible(x.number,'.code');if(code)code.innerHTML=html});const last=rows.at(-1);pendingContinuation=last&&nextLine===last.number&&nextByte>0?{line:nextLine,byte:nextByte}:null;more.style.display=pendingContinuation?'inline-block':'none'};
function loadMore(){if(pendingContinuation)ReactNativeWebView.postMessage(JSON.stringify({type:'continue',line:pendingContinuation.line,byte:pendingContinuation.byte}))}
window.showBinary=()=>{root.style.height='auto';root.innerHTML='<p>Binary preview unavailable.</p>'};
function captureTextSelection(){capturedTextSelection=liveTextSelection()||capturedTextSelection}
function insertRef(){const textSelection=liveTextSelection()||capturedTextSelection,candidate=textSelection||pickedRange();capturedTextSelection=null;const chosen=candidate||{start:viewportLine()-1,end:viewportLine()-1},start=chosen.start+1,end=chosen.end+1,ref=path+':'+start+(end!==start?'-'+end:'');const value=document.getElementById('quote').checked&&textSelection?.text?ref+'\\n> '+textSelection.text.replace(/\\n/g,'\\n> '):ref;ReactNativeWebView.postMessage(JSON.stringify({type:'insert',reference:value}))}
request()</script>`;
}
