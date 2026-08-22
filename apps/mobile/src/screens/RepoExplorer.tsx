import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Modal, PanResponder, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type PanResponderGestureState } from "react-native";
import { WebView as NativeWebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { RepoBrowseEntry, RepoDirectoryListing, RepoFileRange } from "../lib/api/types";
import { highlightTaskFileSource } from "./taskFileSyntaxHighlight";
import { createLoiterRangeLoader, type LoiterRangeLoader } from "./repoExplorerLoiter";
import { appendDirectoryPage, backExplorer, explorerFilterQuery, forwardExplorer, initialExplorerNavigation, navigateExplorer } from "./repoExplorerState";
import { buildViewerDocument, readCompleteRange } from "./repoExplorerViewer";

const DIRECTORY_PAGE_SIZE = 60;
const VIEWPORT_LINE_COUNT = 50;
const NAVIGATION_EDGE_WIDTH = 28;
const NAVIGATION_SWIPE_ACTIVATION = 10;
const NAVIGATION_SWIPE_COMMIT_FRACTION = 0.22;
const NAVIGATION_SWIPE_MIN_COMMIT = 72;
const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<WebViewProps & React.RefAttributes<NativeWebView>>;


export interface RepoExplorerProps {
  title: string;
  listDirectory(path: string, showAllFiles: boolean, offset: number, filter?: string): Promise<RepoDirectoryListing>;
  readFile(path: string, startLine: number, lineCount: number, metadataOnly?: boolean, startByte?: number): Promise<RepoFileRange>;
  onInsertReference(value: string): void;
  onClose(): void;
}

export function RepoExplorer({ title, listDirectory, readFile, onInsertReference, onClose }: RepoExplorerProps) {
  const [navigation, setNavigation] = useState(initialExplorerNavigation);
  const { path, filePath } = navigation.current;
  const [entries, setEntries] = useState<RepoBrowseEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const swipeOffset = useRef(new Animated.Value(0)).current;
  const navigationWidthRef = useRef(390);
  const swipeDirectionRef = useRef<-1 | 1 | null>(null);
  const canGoForwardRef = useRef(false);
  canGoForwardRef.current = navigation.forward.length > 0;
  const listRef = useRef(listDirectory); listRef.current = listDirectory;
  const scopeKey = `${path}\0${filter}\0${showAllFiles}\0${generation}`;
  const directoryScopeRef = useRef({ key: "", generation: 0, inFlightOffsets: new Set<number>() });
  if (directoryScopeRef.current.key !== scopeKey) {
    directoryScopeRef.current = { key: scopeKey, generation: directoryScopeRef.current.generation + 1, inFlightOffsets: new Set() };
  }

  useEffect(() => {
    const scope = directoryScopeRef.current;
    scope.inFlightOffsets.add(0);
    setLoading(true); setError(null);
    void listRef.current(path, showAllFiles, 0, explorerFilterQuery(filter)).then((page) => {
      if (directoryScopeRef.current.generation === scope.generation) {
        setEntries(page.entries); setNextOffset(page.nextOffset); setLoading(false); setRefreshing(false);
      }
    }, (reason: unknown) => {
      if (directoryScopeRef.current.generation === scope.generation) {
        setError(message(reason)); setLoading(false); setRefreshing(false);
      }
    }).finally(() => { scope.inFlightOffsets.delete(0); });
  }, [filter, generation, path, showAllFiles]);

  const visible = useMemo(() => entries, [entries]);
  const goBack = () => {
    if (!filePath && !path) { onClose(); return; }
    setNavigation((current) => backExplorer(current));
    if (!filePath) setFilter("");
  };
  const goForward = () => {
    const next = navigation.forward[0];
    if (!next) return;
    if (next.path !== path) setFilter("");
    setNavigation((current) => forwardExplorer(current));
  };
  const goBackRef = useRef(goBack); goBackRef.current = goBack;
  const goForwardRef = useRef(goForward); goForwardRef.current = goForward;
  const springToRest = () => {
    Animated.spring(swipeOffset, {
      damping: 20,
      mass: 0.75,
      stiffness: 260,
      toValue: 0,
      useNativeDriver: true
    }).start();
  };
  const commitSwipe = (direction: -1 | 1) => {
    const width = navigationWidthRef.current;
    Animated.timing(swipeOffset, {
      duration: 160,
      toValue: direction * width,
      useNativeDriver: true
    }).start(({ finished }) => {
      if (!finished) { springToRest(); return; }
      if (direction === 1) goBackRef.current(); else goForwardRef.current();
      swipeOffset.setValue(-direction * Math.min(width * 0.12, 48));
      springToRest();
    });
  };
  const beginsEdgeSwipe = (gestureState: PanResponderGestureState) => {
    const horizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5;
    if (!horizontal || Math.abs(gestureState.dx) < NAVIGATION_SWIPE_ACTIVATION) return false;
    if (gestureState.dx > 0 && gestureState.x0 <= NAVIGATION_EDGE_WIDTH) {
      swipeDirectionRef.current = 1;
      return true;
    }
    if (gestureState.dx < 0 && gestureState.x0 >= navigationWidthRef.current - NAVIGATION_EDGE_WIDTH && canGoForwardRef.current) {
      swipeDirectionRef.current = -1;
      return true;
    }
    return false;
  };
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) => beginsEdgeSwipe(gestureState),
    onMoveShouldSetPanResponderCapture: (_event, gestureState) => beginsEdgeSwipe(gestureState),
    onPanResponderMove: (_event, gestureState) => {
      const direction = swipeDirectionRef.current;
      if (direction === 1) swipeOffset.setValue(Math.max(0, Math.min(navigationWidthRef.current, gestureState.dx)));
      if (direction === -1) swipeOffset.setValue(Math.min(0, Math.max(-navigationWidthRef.current, gestureState.dx)));
    },
    onPanResponderRelease: (_event, gestureState) => {
      const direction = swipeDirectionRef.current;
      swipeDirectionRef.current = null;
      if (!direction) { springToRest(); return; }
      const threshold = Math.max(NAVIGATION_SWIPE_MIN_COMMIT, navigationWidthRef.current * NAVIGATION_SWIPE_COMMIT_FRACTION);
      const committed = direction * gestureState.dx >= threshold || direction * gestureState.vx > 0.65;
      if (committed) commitSwipe(direction); else springToRest();
    },
    onPanResponderTerminate: () => {
      swipeDirectionRef.current = null;
      springToRest();
    },
    onPanResponderTerminationRequest: () => false
  }), []);
  const measureNavigation = (event: LayoutChangeEvent) => {
    navigationWidthRef.current = event.nativeEvent.layout.width;
  };
  const loadNext = () => {
    if (nextOffset == null) return;
    const scope = directoryScopeRef.current;
    const offset = nextOffset;
    if (scope.inFlightOffsets.has(offset)) return;
    scope.inFlightOffsets.add(offset); setLoading(true);
    void listRef.current(path,showAllFiles,offset,explorerFilterQuery(filter)).then((page)=>{
      if(directoryScopeRef.current.generation===scope.generation){setEntries((current)=>appendDirectoryPage(current,page.entries));setNextOffset(page.nextOffset);setLoading(false);}
    },(reason:unknown)=>{
      if(directoryScopeRef.current.generation===scope.generation){setError(message(reason));setLoading(false);}
    }).finally(()=>{scope.inFlightOffsets.delete(offset);});
  };

  return <Modal animationType="slide" onRequestClose={goBack} presentationStyle="fullScreen" visible><SafeAreaView style={styles.safeArea} testID="mobile.repo-explorer"><Animated.View onLayout={measureNavigation} style={[styles.navigationPage,{transform:[{translateX:swipeOffset}]}]} testID="mobile.repo-explorer.navigation-surface" {...panResponder.panHandlers}>
    <View style={styles.header}><Pressable onPress={goBack} testID="mobile.repo-explorer.back"><Text style={styles.action}>Back</Text></Pressable><View style={styles.headerCopy}><Text numberOfLines={1} style={styles.title}>{filePath ?? title}</Text><Text numberOfLines={1} style={styles.breadcrumb}>{path || "Task worktree"}</Text></View><Pressable onPress={onClose}><Text style={styles.action}>Close</Text></Pressable></View>
    {filePath ? <LoiterFileViewer path={filePath} readFile={readFile} onInsertReference={onInsertReference} /> : <>
      <View style={styles.controls}><TextInput autoCapitalize="none" autoCorrect={false} onChangeText={setFilter} placeholder="Filter this folder" placeholderTextColor="#7185A3" style={styles.filter} testID="mobile.repo-explorer.filter" value={filter}/><Pressable accessibilityRole="switch" accessibilityState={{checked:showAllFiles}} onPress={()=>setShowAllFiles((value)=>!value)}><Text style={styles.toggle}>{showAllFiles?"Hide ignored":"Show all"}</Text></Pressable></View>
      {error?<Text style={styles.error}>{error}</Text>:null}
      <FlatList data={visible} keyExtractor={(entry)=>entry.path} onEndReached={loadNext} onEndReachedThreshold={0.5} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRefreshing(true);setGeneration((value)=>value+1);}} tintColor="#73B7FF"/>} renderItem={({item})=><Pressable onPress={()=>{setNavigation((current)=>navigateExplorer(current,{path:item.isDir?item.path:path,filePath:item.isDir?null:item.path}));if(item.isDir)setFilter("");}} style={styles.row} testID={`mobile.repo-explorer.entry.${item.path}`}><Text style={styles.icon}>{item.isDir?"▸":""}</Text><Text numberOfLines={1} style={styles.name}>{item.name}</Text>{!item.isDir&&item.size!=null?<Text style={styles.size}>{formatBytes(item.size)}</Text>:null}</Pressable>} ListFooterComponent={loading?<ActivityIndicator color="#73B7FF" style={styles.loader}/>:null}/>
    </>}
  </Animated.View></SafeAreaView></Modal>;
}

export function LoiterFileViewer({ path, readFile, onInsertReference }: { path:string; readFile(path:string,startLine:number,lineCount:number,metadataOnly?:boolean,startByte?:number):Promise<RepoFileRange>; onInsertReference(value:string):void }) {
  const webRef = useRef<NativeWebView>(null);
  const contentRanges = useRef(new Set<string>());
  const metadataRanges = useRef(new Set<string>());
  const readFileRef = useRef(readFile); readFileRef.current = readFile;
  const viewerGenerationRef = useRef(0);
  const [initial, setInitial] = useState<RepoFileRange|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{const viewerGeneration=++viewerGenerationRef.current;contentRanges.current.clear();metadataRanges.current.clear();setInitial(null);setError(null);void readFileRef.current(path,0,VIEWPORT_LINE_COUNT,true).then((range)=>{if(viewerGenerationRef.current===viewerGeneration)setInitial(range);},(reason:unknown)=>{if(viewerGenerationRef.current===viewerGeneration)setError(message(reason));});return()=>{if(viewerGenerationRef.current===viewerGeneration)viewerGenerationRef.current++;};},[path]);
  const inject=(script:string)=>webRef.current?.injectJavaScript(`${script};true;`);
  const fetchRange=(start:number, metadataOnly:boolean,startByte=0)=>{const key=`${start}:${VIEWPORT_LINE_COUNT}:${startByte}`;const cache=metadataOnly?metadataRanges.current:contentRanges.current;if(cache.has(key))return;const viewerGeneration=viewerGenerationRef.current;cache.add(key);void readCompleteRange(readFileRef.current,path,start,VIEWPORT_LINE_COUNT,metadataOnly,startByte).then((range)=>{if(viewerGenerationRef.current!==viewerGeneration)return;if(range.binary){inject("window.showBinary()");return;} const payload=metadataOnly?range.lines.map((length,index)=>({number:start+index,length:Number(length)})):range.lines.map((text,index)=>({number:start+index,text,html:highlightTaskFileSource(text,path)}));inject(metadataOnly?`window.applyMetadata(${JSON.stringify(payload)})`:`window.applyContent(${JSON.stringify(payload)},${startByte},${JSON.stringify(range.nextLine)},${JSON.stringify(range.nextByte??null)})`);},(reason:unknown)=>{if(viewerGenerationRef.current===viewerGeneration){cache.delete(key);setError(message(reason));}});};
  const rangeLoaderRef=useRef<LoiterRangeLoader|null>(null);
  useEffect(()=>{const loader=createLoiterRangeLoader((start)=>fetchRange(start,false));rangeLoaderRef.current=loader;return()=>{loader.dispose();if(rangeLoaderRef.current===loader)rangeLoaderRef.current=null;};},[path]);
  const onMessage=(event:WebViewMessageEvent)=>{try{const data=JSON.parse(event.nativeEvent.data) as {type?:unknown;start?:unknown;line?:unknown;byte?:unknown;reference?:unknown};if(data.type==="viewport"&&typeof data.start==="number"){fetchRange(data.start,true);rangeLoaderRef.current?.observe(data.start);}else if(data.type==="continue"&&typeof data.line==="number"&&typeof data.byte==="number"){fetchRange(data.line,false,data.byte);}else if(data.type==="insert"&&typeof data.reference==="string"){onInsertReference(data.reference);}}catch(error){setError(message(error));}};
  if(error)return <Text style={styles.error}>{error}</Text>; if(!initial)return <ActivityIndicator color="#73B7FF" style={styles.loader}/>; if(initial.binary)return <View style={styles.center}><Text style={styles.binaryTitle}>Binary file</Text><Text style={styles.muted}>Preview is unavailable for this file.</Text></View>;
  metadataRanges.current.add(`0:${VIEWPORT_LINE_COUNT}:0`);
  return <View style={styles.viewer}><WebView ref={webRef} originWhitelist={["about:blank"]} onMessage={onMessage} onScroll={(event:NativeSyntheticEvent<NativeScrollEvent>)=>inject(`window.setNativeScrollY?.(${event.nativeEvent.contentOffset.y})`)} source={{html:buildViewerDocument(path,initial)}} style={styles.webView}/>{error?<Text style={styles.error}>{error}</Text>:null}</View>;
}

function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
function formatBytes(bytes:number):string{return bytes<1024?`${bytes} B`:`${(bytes/1024).toFixed(bytes<10240?1:0)} KB`}
const styles=StyleSheet.create({safeArea:{backgroundColor:"#08111E",flex:1},navigationPage:{backgroundColor:"#08111E",flex:1},header:{alignItems:"center",borderBottomColor:"#20304C",borderBottomWidth:1,flexDirection:"row",gap:12,padding:14},headerCopy:{flex:1},title:{color:"#F5F7FB",fontSize:17,fontWeight:"800"},breadcrumb:{color:"#8398B8",fontSize:12},action:{color:"#73B7FF",fontSize:15,fontWeight:"700"},controls:{alignItems:"center",flexDirection:"row",gap:10,padding:12},filter:{backgroundColor:"#111C30",borderColor:"#263754",borderRadius:10,borderWidth:1,color:"#F5F7FB",flex:1,padding:10},toggle:{color:"#9EC8F0",fontSize:12,fontWeight:"700"},row:{alignItems:"center",borderBottomColor:"#17243A",borderBottomWidth:1,flexDirection:"row",minHeight:50,paddingHorizontal:16},icon:{color:"#73B7FF",width:20},name:{color:"#E8EEF8",flex:1,fontSize:15},size:{color:"#7185A3",fontSize:12},loader:{padding:24},error:{color:"#FF9C9C",padding:16,textAlign:"center"},center:{alignItems:"center",flex:1,justifyContent:"center"},binaryTitle:{color:"#F5F7FB",fontSize:20,fontWeight:"800"},muted:{color:"#8398B8"},viewer:{flex:1},webView:{backgroundColor:"#08111E",flex:1}});
