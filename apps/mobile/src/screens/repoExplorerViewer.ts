import type { RepoFileRange } from "../lib/api/types";

export interface RepoRangeReader {
  (path:string,startLine:number,lineCount:number,metadataOnly?:boolean,startByte?:number):Promise<RepoFileRange>;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/&/g,"\\u0026").replace(/</g,"\\u003c").replace(/>/g,"\\u003e");
}

export async function readCompleteRange(readFile:RepoRangeReader,path:string,startLine:number,lineCount:number,metadataOnly:boolean):Promise<RepoFileRange>{
  const range=await readFile(path,startLine,lineCount,metadataOnly,0);
  if(metadataOnly||range.binary)return range;
  const lines=[...range.lines]; let nextLine=range.nextLine; let nextByte=range.nextByte??null;
  while(nextLine!==null&&nextByte!==null&&nextByte>0&&nextLine===startLine+lines.length-1){
    const continuation=await readFile(path,nextLine,lineCount,false,nextByte);
    lines[lines.length-1]=(lines[lines.length-1]??"")+(continuation.lines[0]??"");
    lines.push(...continuation.lines.slice(1)); nextLine=continuation.nextLine; nextByte=continuation.nextByte??null;
  }
  return {...range,lines,nextLine,nextByte};
}

export function buildViewerDocument(path:string,initial:RepoFileRange):string { const lengths=initial.lines.map(Number); return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#08111e;color:#dce7f5;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}#bar{position:sticky;top:0;z-index:2;background:#101b2e;padding:8px;border-bottom:1px solid #263754}button{background:#28476d;color:white;border:0;border-radius:7px;padding:7px 10px}#lines{position:relative;height:${initial.totalLines*20}px}.line{height:20px;white-space:pre;display:flex;position:absolute;left:0}.num{color:#5e7290;width:52px;text-align:right;padding-right:12px;user-select:none}.code{min-width:max-content}.sk{height:10px;margin-top:5px;border-radius:4px;background:#1c2c46}.hljs-keyword,.hljs-selector-tag{color:#ff7ab2}.hljs-string,.hljs-attr{color:#a8cc8c}.hljs-number,.hljs-literal{color:#d2a8ff}.hljs-comment{color:#70819d}</style><div id="bar"><button onclick="insertRef()">Insert reference in reply</button> <label><input id="quote" type="checkbox"> include selected text</label></div><div id="lines"></div><script>const path=${scriptJson(path)},total=${initial.totalLines},windowSize=90,heights=new Map(${scriptJson(lengths.map((length,index)=>[index,length]))}),content=new Map();const root=document.getElementById('lines');let windowStart=-1;function visible(number,selector){return root.querySelector('[data-line="'+number+'"] '+selector)}function render(start){start=Math.max(0,Math.min(Math.max(0,total-windowSize),start));if(start===windowStart)return;windowStart=start;root.replaceChildren();const end=Math.min(total,start+windowSize);for(let i=start;i<end;i++){const row=document.createElement('div');row.className='line';row.dataset.line=i;row.style.top=(i*20)+'px';const cached=content.get(i);row.innerHTML='<span class="num">'+(i+1)+'</span><span class="code">'+(cached??'<span class="sk" style="width:'+Math.max(24,Math.min(720,(heights.get(i)||18)*7))+'px"></span>')+'</span>';root.appendChild(row)}}function request(){const start=Math.max(0,Math.floor(scrollY/20)-10);render(start);ReactNativeWebView.postMessage(JSON.stringify({type:'viewport',start}))}addEventListener('scroll',request,{passive:true});window.applyMetadata=(rows)=>rows.forEach(x=>{heights.set(x.number,x.length);const sk=visible(x.number,'.sk');if(sk)sk.style.width=Math.max(24,Math.min(720,x.length*7))+'px'});window.applyContent=(rows)=>rows.forEach(x=>{const html=x.html||' ';content.set(x.number,html);const code=visible(x.number,'.code');if(code)code.innerHTML=html});window.showBinary=()=>{root.style.height='auto';root.innerHTML='<p>Binary preview unavailable.</p>'};function insertRef(){const selection=getSelection(),text=selection?.toString()||'';let start=Math.floor(scrollY/20)+1,end=start;if(selection&&selection.rangeCount){const range=selection.getRangeAt(0);const a=range.startContainer.parentElement?.closest('.line'),b=range.endContainer.parentElement?.closest('.line');if(a)start=Number(a.dataset.line)+1;if(b)end=Number(b.dataset.line)+1}const ref=path+':'+start+(end!==start?'-'+end:'');const value=document.getElementById('quote').checked&&text?ref+'\\n> '+text.replace(/\\n/g,'\\n> '):ref;ReactNativeWebView.postMessage(JSON.stringify({type:'insert',reference:value}))}request()</script>`; }
