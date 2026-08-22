import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView as NativeWebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { RepoBrowseEntry, RepoDirectoryListing, RepoFileRange } from "../lib/api/types";
import { highlightTaskFileSource } from "./taskFileSyntaxHighlight";
import { createLoiterRangeLoader, type LoiterRangeLoader } from "./repoExplorerLoiter";
import { appendDirectoryPage, explorerFilterQuery, parentExplorerPath } from "./repoExplorerState";

const DIRECTORY_PAGE_SIZE = 60;
const VIEWPORT_LINE_COUNT = 50;
const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<WebViewProps & React.RefAttributes<NativeWebView>>;


export interface RepoExplorerProps {
  title: string;
  listDirectory(path: string, showAllFiles: boolean, offset: number, filter?: string): Promise<RepoDirectoryListing>;
  readFile(path: string, startLine: number, lineCount: number, metadataOnly?: boolean): Promise<RepoFileRange>;
  onInsertReference(value: string): void;
  onClose(): void;
}

export function RepoExplorer({ title, listDirectory, readFile, onInsertReference, onClose }: RepoExplorerProps) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RepoBrowseEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const listRef = useRef(listDirectory); listRef.current = listDirectory;

  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    void listRef.current(path, showAllFiles, 0, explorerFilterQuery(filter)).then((page) => { if (active) { setEntries(page.entries); setNextOffset(page.nextOffset); setLoading(false); setRefreshing(false); } }, (reason: unknown) => { if (active) { setError(message(reason)); setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [filter, generation, path, showAllFiles]);

  const visible = useMemo(() => entries, [entries]);
  const goBack = () => { if (filePath) { setFilePath(null); return; } if (!path) { onClose(); return; } setPath(parentExplorerPath(path)); setFilter(""); };
  const loadNext = () => { if (nextOffset == null || loading) return; setLoading(true); void listRef.current(path,showAllFiles,nextOffset,explorerFilterQuery(filter)).then((page)=>{setEntries((current)=>appendDirectoryPage(current,page.entries));setNextOffset(page.nextOffset);setLoading(false);},(reason:unknown)=>{setError(message(reason));setLoading(false);}); };

  return <Modal animationType="slide" onRequestClose={goBack} presentationStyle="fullScreen" visible><SafeAreaView style={styles.safeArea} testID="mobile.repo-explorer">
    <View style={styles.header}><Pressable onPress={goBack} testID="mobile.repo-explorer.back"><Text style={styles.action}>Back</Text></Pressable><View style={styles.headerCopy}><Text numberOfLines={1} style={styles.title}>{filePath ?? title}</Text><Text numberOfLines={1} style={styles.breadcrumb}>{path || "Task worktree"}</Text></View><Pressable onPress={onClose}><Text style={styles.action}>Close</Text></Pressable></View>
    {filePath ? <LoiterFileViewer path={filePath} readFile={readFile} onInsertReference={onInsertReference} /> : <>
      <View style={styles.controls}><TextInput autoCapitalize="none" autoCorrect={false} onChangeText={setFilter} placeholder="Filter this folder" placeholderTextColor="#7185A3" style={styles.filter} testID="mobile.repo-explorer.filter" value={filter}/><Pressable accessibilityRole="switch" accessibilityState={{checked:showAllFiles}} onPress={()=>setShowAllFiles((value)=>!value)}><Text style={styles.toggle}>{showAllFiles?"Hide ignored":"Show all"}</Text></Pressable></View>
      {error?<Text style={styles.error}>{error}</Text>:null}
      <FlatList data={visible} keyExtractor={(entry)=>entry.path} onEndReached={loadNext} onEndReachedThreshold={0.5} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRefreshing(true);setGeneration((value)=>value+1);}} tintColor="#73B7FF"/>} renderItem={({item})=><Pressable onPress={()=>item.isDir?(setPath(item.path),setFilter("")):setFilePath(item.path)} style={styles.row} testID={`mobile.repo-explorer.entry.${item.path}`}><Text style={styles.icon}>{item.isDir?"▸":""}</Text><Text numberOfLines={1} style={styles.name}>{item.name}</Text>{!item.isDir&&item.size!=null?<Text style={styles.size}>{formatBytes(item.size)}</Text>:null}</Pressable>} ListFooterComponent={loading?<ActivityIndicator color="#73B7FF" style={styles.loader}/>:null}/>
    </>}
  </SafeAreaView></Modal>;
}

function LoiterFileViewer({ path, readFile, onInsertReference }: { path:string; readFile(path:string,startLine:number,lineCount:number,metadataOnly?:boolean):Promise<RepoFileRange>; onInsertReference(value:string):void }) {
  const webRef = useRef<NativeWebView>(null);
  const contentRanges = useRef(new Set<string>());
  const metadataRanges = useRef(new Set<string>());
  const [initial, setInitial] = useState<RepoFileRange|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true; contentRanges.current.clear();metadataRanges.current.clear();setInitial(null);void readFile(path,0,VIEWPORT_LINE_COUNT,true).then((range)=>{if(active)setInitial(range);},(reason:unknown)=>{if(active)setError(message(reason));});return()=>{active=false;};},[path,readFile]);
  const inject=(script:string)=>webRef.current?.injectJavaScript(`${script};true;`);
  const fetchRange=(start:number, metadataOnly:boolean)=>{const key=`${start}:${VIEWPORT_LINE_COUNT}`;const cache=metadataOnly?metadataRanges.current:contentRanges.current;if(cache.has(key))return;cache.add(key);void readFile(path,start,VIEWPORT_LINE_COUNT,metadataOnly).then((range)=>{if(range.binary){inject("window.showBinary()");return;} const payload=metadataOnly?range.lines.map((length,index)=>({number:start+index,length:Number(length)})):range.lines.map((text,index)=>({number:start+index,text,html:highlightTaskFileSource(text,path)}));inject(`window.${metadataOnly?"applyMetadata":"applyContent"}(${JSON.stringify(payload)})`);},(reason:unknown)=>{cache.delete(key);setError(message(reason));});};
  const rangeLoaderRef=useRef<LoiterRangeLoader|null>(null);
  useEffect(()=>{const loader=createLoiterRangeLoader((start)=>fetchRange(start,false));rangeLoaderRef.current=loader;return()=>{loader.dispose();if(rangeLoaderRef.current===loader)rangeLoaderRef.current=null;};},[path]);
  const onMessage=(event:WebViewMessageEvent)=>{try{const data=JSON.parse(event.nativeEvent.data) as {type?:unknown;start?:unknown;reference?:unknown};if(data.type==="viewport"&&typeof data.start==="number"){fetchRange(data.start,true);rangeLoaderRef.current?.observe(data.start);}else if(data.type==="insert"&&typeof data.reference==="string"){onInsertReference(data.reference);}}catch(error){setError(message(error));}};
  if(error)return <Text style={styles.error}>{error}</Text>; if(!initial)return <ActivityIndicator color="#73B7FF" style={styles.loader}/>; if(initial.binary)return <View style={styles.center}><Text style={styles.binaryTitle}>Binary file</Text><Text style={styles.muted}>Preview is unavailable for this file.</Text></View>;
  metadataRanges.current.add(`0:${VIEWPORT_LINE_COUNT}`);
  return <View style={styles.viewer}><WebView ref={webRef} originWhitelist={["about:blank"]} onMessage={onMessage} source={{html:buildViewerDocument(path,initial)}} style={styles.webView}/>{error?<Text style={styles.error}>{error}</Text>:null}</View>;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function buildViewerDocument(path:string,initial:RepoFileRange):string { const lengths=initial.lines.map(Number); return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#08111e;color:#dce7f5;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}#bar{position:sticky;top:0;z-index:2;background:#101b2e;padding:8px;border-bottom:1px solid #263754}button{background:#28476d;color:white;border:0;border-radius:7px;padding:7px 10px}.line{height:20px;white-space:pre;display:flex}.num{color:#5e7290;width:52px;text-align:right;padding-right:12px;user-select:none}.code{min-width:max-content}.sk{height:10px;margin-top:5px;border-radius:4px;background:#1c2c46}.hljs-keyword,.hljs-selector-tag{color:#ff7ab2}.hljs-string,.hljs-attr{color:#a8cc8c}.hljs-number,.hljs-literal{color:#d2a8ff}.hljs-comment{color:#70819d}</style><div id="bar"><button onclick="insertRef()">Insert reference in reply</button> <label><input id="quote" type="checkbox"> include selected text</label></div><div id="lines"></div><script>const path=${scriptJson(path)},total=${initial.totalLines},heights=${scriptJson(lengths)};const root=document.getElementById('lines');for(let i=0;i<total;i++){const row=document.createElement('div');row.className='line';row.dataset.line=i;row.innerHTML='<span class="num">'+(i+1)+'</span><span class="code"><span class="sk" style="width:'+Math.max(24,Math.min(720,(heights[i]||18)*7))+'px"></span></span>';root.appendChild(row)}function request(){const start=Math.max(0,Math.floor(scrollY/20)-10);ReactNativeWebView.postMessage(JSON.stringify({type:'viewport',start}))}addEventListener('scroll',request,{passive:true});window.applyMetadata=(rows)=>rows.forEach(x=>{const sk=root.children[x.number]?.querySelector('.sk');if(sk)sk.style.width=Math.max(24,Math.min(720,x.length*7))+'px'});window.applyContent=(rows)=>rows.forEach(x=>{const code=root.children[x.number]?.querySelector('.code');if(code)code.innerHTML=x.html||' '});window.showBinary=()=>root.innerHTML='<p>Binary preview unavailable.</p>';function insertRef(){const selection=getSelection(),text=selection?.toString()||'';let start=Math.floor(scrollY/20)+1,end=start;if(selection&&selection.rangeCount){const range=selection.getRangeAt(0);const a=range.startContainer.parentElement?.closest('.line'),b=range.endContainer.parentElement?.closest('.line');if(a)start=Number(a.dataset.line)+1;if(b)end=Number(b.dataset.line)+1}const ref=path+':'+start+(end!==start?'-'+end:'');const value=document.getElementById('quote').checked&&text?ref+'\n> '+text.replace(/\n/g,'\n> '):ref;ReactNativeWebView.postMessage(JSON.stringify({type:'insert',reference:value}))}request()</script>`; }
function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
function formatBytes(bytes:number):string{return bytes<1024?`${bytes} B`:`${(bytes/1024).toFixed(bytes<10240?1:0)} KB`}
const styles=StyleSheet.create({safeArea:{backgroundColor:"#08111E",flex:1},header:{alignItems:"center",borderBottomColor:"#20304C",borderBottomWidth:1,flexDirection:"row",gap:12,padding:14},headerCopy:{flex:1},title:{color:"#F5F7FB",fontSize:17,fontWeight:"800"},breadcrumb:{color:"#8398B8",fontSize:12},action:{color:"#73B7FF",fontSize:15,fontWeight:"700"},controls:{alignItems:"center",flexDirection:"row",gap:10,padding:12},filter:{backgroundColor:"#111C30",borderColor:"#263754",borderRadius:10,borderWidth:1,color:"#F5F7FB",flex:1,padding:10},toggle:{color:"#9EC8F0",fontSize:12,fontWeight:"700"},row:{alignItems:"center",borderBottomColor:"#17243A",borderBottomWidth:1,flexDirection:"row",minHeight:50,paddingHorizontal:16},icon:{color:"#73B7FF",width:20},name:{color:"#E8EEF8",flex:1,fontSize:15},size:{color:"#7185A3",fontSize:12},loader:{padding:24},error:{color:"#FF9C9C",padding:16,textAlign:"center"},center:{alignItems:"center",flex:1,justifyContent:"center"},binaryTitle:{color:"#F5F7FB",fontSize:20,fontWeight:"800"},muted:{color:"#8398B8"},viewer:{flex:1},webView:{backgroundColor:"#08111E",flex:1}});
