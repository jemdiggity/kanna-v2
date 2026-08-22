import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Modal, PanResponder, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type PanResponderGestureState } from "react-native";
import { WebView as NativeWebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { RepoBrowseEntry, RepoDirectoryListing, RepoFileRange } from "../lib/api/types";
import { highlightTaskFileSource } from "./taskFileSyntaxHighlight";
import { createLoiterRangeLoader, type LoiterRangeLoader } from "./repoExplorerLoiter";
import { appendDirectoryPage, backExplorer, explorerFilterQuery, forwardExplorer, initialExplorerNavigation, navigateExplorer, type RepoExplorerLocation, type RepoExplorerNavigation } from "./repoExplorerState";
import { buildViewerDocument, readCompleteRange } from "./repoExplorerViewer";

const VIEWPORT_LINE_COUNT = 50;
const NAVIGATION_EDGE_WIDTH = 28;
const NAVIGATION_SWIPE_ACTIVATION = 10;
const NAVIGATION_SWIPE_COMMIT_FRACTION = 0.22;
const NAVIGATION_SWIPE_MIN_COMMIT = 72;
const NAVIGATION_INCOMING_OFFSET_FRACTION = 0.28;
const WebView = NativeWebView as unknown as React.ForwardRefExoticComponent<WebViewProps & React.RefAttributes<NativeWebView>>;

interface ExplorerTransition {
  direction: -1 | 1;
  incoming: RepoExplorerLocation | null;
  incomingEntries: RepoBrowseEntry[];
  incomingFilter: string;
}

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
  const [entriesKey, setEntriesKey] = useState("");
  const [transition, setTransition] = useState<ExplorerTransition | null>(null);
  const [navigationWidth, setNavigationWidth] = useState(390);
  const swipeOffset = useRef(new Animated.Value(0)).current;
  const navigationWidthRef = useRef(390);
  const swipeDirectionRef = useRef<-1 | 1 | null>(null);
  const swipeStartOffsetRef = useRef(0);
  const swipeSequenceRef = useRef(0);
  const navigationRef = useRef(navigation);
  const filterRef = useRef(filter);
  const showAllFilesRef = useRef(showAllFiles);
  const directoryCacheRef = useRef(new Map<string, RepoBrowseEntry[]>());
  const canGoForwardRef = useRef(false);
  navigationRef.current = navigation;
  filterRef.current = filter;
  showAllFilesRef.current = showAllFiles;
  canGoForwardRef.current = navigation.forward.length > 0;
  const listRef = useRef(listDirectory); listRef.current = listDirectory;
  const scopeKey = `${path}\0${filter}\0${showAllFiles}\0${generation}`;
  const listingKey = directoryListingKey(path, filter, showAllFiles);
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
        directoryCacheRef.current.set(listingKey, page.entries);
        setEntries(page.entries); setEntriesKey(listingKey); setNextOffset(page.nextOffset); setLoading(false); setRefreshing(false);
      }
    }, (reason: unknown) => {
      if (directoryScopeRef.current.generation === scope.generation) {
        setError(message(reason)); setLoading(false); setRefreshing(false);
      }
    }).finally(() => { scope.inFlightOffsets.delete(0); });
  }, [filter, generation, listingKey, path, showAllFiles]);

  const visible = entriesKey === listingKey ? entries : directoryCacheRef.current.get(listingKey) ?? [];
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
  const spring = (toValue: number, sequence: number, onFinished?: () => void) => {
    Animated.spring(swipeOffset, {
      damping: 20,
      mass: 0.75,
      stiffness: 260,
      toValue,
      useNativeDriver: true
    }).start(({ finished }) => {
      if (finished && swipeSequenceRef.current === sequence) onFinished?.();
    });
  };
  const springToRest = () => {
    const sequence = swipeSequenceRef.current;
    spring(0, sequence, () => setTransition(null));
  };
  const commitSwipe = (direction: -1 | 1) => {
    const width = navigationWidthRef.current;
    const sequence = swipeSequenceRef.current;
    spring(direction * width, sequence, () => {
      if (direction === 1) goBackRef.current(); else goForwardRef.current();
      swipeStartOffsetRef.current = 0;
      swipeOffset.setValue(0);
      setTransition(null);
    });
  };
  const beginTransition = (direction: -1 | 1) => {
    const currentNavigation = navigationRef.current;
    const destinationNavigation: RepoExplorerNavigation = direction === 1
      ? backExplorer(currentNavigation)
      : forwardExplorer(currentNavigation);
    const incoming = destinationNavigation === currentNavigation ? null : destinationNavigation.current;
    const incomingFilter = incoming && incoming.path !== currentNavigation.current.path ? "" : filterRef.current;
    const incomingEntries = incoming?.filePath
      ? []
      : directoryCacheRef.current.get(directoryListingKey(incoming?.path ?? "", incomingFilter, showAllFilesRef.current)) ?? [];
    swipeSequenceRef.current += 1;
    swipeOffset.stopAnimation((value) => { swipeStartOffsetRef.current = value; });
    swipeDirectionRef.current = direction;
    setTransition({ direction, incoming, incomingEntries, incomingFilter });
  };
  const beginsEdgeSwipe = (gestureState: PanResponderGestureState) => {
    const horizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5;
    if (!horizontal || Math.abs(gestureState.dx) < NAVIGATION_SWIPE_ACTIVATION) return false;
    if (gestureState.dx > 0 && gestureState.x0 <= NAVIGATION_EDGE_WIDTH) {
      if (swipeDirectionRef.current !== 1) beginTransition(1);
      return true;
    }
    if (gestureState.dx < 0 && gestureState.x0 >= navigationWidthRef.current - NAVIGATION_EDGE_WIDTH && canGoForwardRef.current) {
      if (swipeDirectionRef.current !== -1) beginTransition(-1);
      return true;
    }
    return false;
  };
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) => beginsEdgeSwipe(gestureState),
    onMoveShouldSetPanResponderCapture: (_event, gestureState) => beginsEdgeSwipe(gestureState),
    onPanResponderMove: (_event, gestureState) => {
      const direction = swipeDirectionRef.current;
      const offset = swipeStartOffsetRef.current + gestureState.dx;
      if (direction === 1) swipeOffset.setValue(Math.max(0, Math.min(navigationWidthRef.current, offset)));
      if (direction === -1) swipeOffset.setValue(Math.min(0, Math.max(-navigationWidthRef.current, offset)));
    },
    onPanResponderRelease: (_event, gestureState) => {
      const direction = swipeDirectionRef.current;
      swipeDirectionRef.current = null;
      if (!direction) { springToRest(); return; }
      const threshold = Math.max(NAVIGATION_SWIPE_MIN_COMMIT, navigationWidthRef.current * NAVIGATION_SWIPE_COMMIT_FRACTION);
      const committed = direction * (swipeStartOffsetRef.current + gestureState.dx) >= threshold || direction * gestureState.vx > 0.65;
      if (committed) commitSwipe(direction); else springToRest();
    },
    onPanResponderTerminate: () => {
      swipeDirectionRef.current = null;
      springToRest();
    },
    onPanResponderTerminationRequest: () => false
  }), []);
  const measureNavigation = (event: LayoutChangeEvent) => {
    const measuredWidth = event.nativeEvent.layout.width;
    navigationWidthRef.current = measuredWidth;
    setNavigationWidth(measuredWidth);
  };
  const loadNext = () => {
    if (nextOffset == null) return;
    const scope = directoryScopeRef.current;
    const offset = nextOffset;
    if (scope.inFlightOffsets.has(offset)) return;
    scope.inFlightOffsets.add(offset); setLoading(true);
    void listRef.current(path,showAllFiles,offset,explorerFilterQuery(filter)).then((page)=>{
      if(directoryScopeRef.current.generation===scope.generation){setEntries((current)=>{const next=appendDirectoryPage(current,page.entries);directoryCacheRef.current.set(listingKey,next);return next;});setEntriesKey(listingKey);setNextOffset(page.nextOffset);setLoading(false);}
    },(reason:unknown)=>{
      if(directoryScopeRef.current.generation===scope.generation){setError(message(reason));setLoading(false);}
    }).finally(()=>{scope.inFlightOffsets.delete(offset);});
  };

  const renderPage = (location: RepoExplorerLocation, pageEntries: RepoBrowseEntry[], pageFilter: string, interactive: boolean) => <View style={styles.navigationPage} testID={interactive ? "mobile.repo-explorer.current-page" : "mobile.repo-explorer.incoming-page"}>
    <View style={styles.header}><Pressable onPress={interactive ? goBack : undefined} testID={interactive ? "mobile.repo-explorer.back" : undefined}><Text style={styles.action}>Back</Text></Pressable><View style={styles.headerCopy}><Text numberOfLines={1} style={styles.title}>{location.filePath ?? title}</Text><Text numberOfLines={1} style={styles.breadcrumb}>{location.path || "Task worktree"}</Text></View><Pressable onPress={interactive ? onClose : undefined}><Text style={styles.action}>Close</Text></Pressable></View>
    {location.filePath ? <LoiterFileViewer path={location.filePath} readFile={readFile} onInsertReference={onInsertReference} /> : <>
      <View style={styles.controls}><TextInput autoCapitalize="none" autoCorrect={false} editable={interactive} onChangeText={interactive ? setFilter : undefined} placeholder="Filter this folder" placeholderTextColor="#7185A3" style={styles.filter} testID={interactive ? "mobile.repo-explorer.filter" : undefined} value={pageFilter}/><Pressable accessibilityRole="switch" accessibilityState={{checked:showAllFiles}} disabled={!interactive} onPress={interactive ? ()=>setShowAllFiles((value)=>!value) : undefined}><Text style={styles.toggle}>{showAllFiles?"Hide ignored":"Show all"}</Text></Pressable></View>
      {interactive && error?<Text style={styles.error}>{error}</Text>:null}
      <FlatList contentContainerStyle={styles.listContent} data={pageEntries} keyExtractor={(entry)=>entry.path} onEndReached={interactive ? loadNext : undefined} onEndReachedThreshold={0.5} refreshControl={interactive?<RefreshControl refreshing={refreshing} onRefresh={()=>{setRefreshing(true);setGeneration((value)=>value+1);}} tintColor="#73B7FF"/>:undefined} renderItem={({item})=><Pressable disabled={!interactive} onPress={interactive ? ()=>{setNavigation((current)=>navigateExplorer(current,{path:item.isDir?item.path:location.path,filePath:item.isDir?null:item.path}));if(item.isDir)setFilter("");} : undefined} style={styles.row} testID={interactive ? `mobile.repo-explorer.entry.${item.path}` : undefined}><Text style={styles.icon}>{item.isDir?"▸":""}</Text><Text numberOfLines={1} style={styles.name}>{item.name}</Text>{!item.isDir&&item.size!=null?<Text style={styles.size}>{formatBytes(item.size)}</Text>:null}</Pressable>} ListFooterComponent={interactive&&loading?<ActivityIndicator color="#73B7FF" style={styles.loader}/>:null}/>
    </>}
  </View>;
  const width = navigationWidth;
  const incomingTranslate = transition?.direction === 1
    ? swipeOffset.interpolate({ inputRange: [0, width], outputRange: [-width * NAVIGATION_INCOMING_OFFSET_FRACTION, 0], extrapolate: "clamp" })
    : swipeOffset.interpolate({ inputRange: [-width, 0], outputRange: [0, width * NAVIGATION_INCOMING_OFFSET_FRACTION], extrapolate: "clamp" });
  const incomingDim = transition?.direction === 1
    ? swipeOffset.interpolate({ inputRange: [0, width], outputRange: [0.18, 0], extrapolate: "clamp" })
    : swipeOffset.interpolate({ inputRange: [-width, 0], outputRange: [0, 0.18], extrapolate: "clamp" });

  return <Modal animationType="slide" onRequestClose={goBack} presentationStyle="fullScreen" visible><SafeAreaView onLayout={measureNavigation} style={styles.safeArea} testID="mobile.repo-explorer"><View style={styles.gestureSurface} testID="mobile.repo-explorer.navigation-surface" {...panResponder.panHandlers}>
    {transition?.incoming?<Animated.View key={explorerLocationKey(transition.incoming)} pointerEvents="none" style={[styles.incomingLayer,{transform:[{translateX:incomingTranslate}]}]} testID="mobile.repo-explorer.incoming-surface">{renderPage(transition.incoming,transition.incomingEntries,transition.incomingFilter,false)}<Animated.View style={[styles.incomingDim,{opacity:incomingDim}]}/></Animated.View>:null}
    <Animated.View key={explorerLocationKey(navigation.current)} style={[styles.currentLayer,{transform:[{translateX:swipeOffset}]}]} testID="mobile.repo-explorer.outgoing-surface">{renderPage(navigation.current,visible,filter,true)}</Animated.View>
  </View></SafeAreaView></Modal>;
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
function directoryListingKey(path:string,filter:string,showAllFiles:boolean):string{return `${path}\0${explorerFilterQuery(filter)}\0${showAllFiles}`}
function explorerLocationKey(location:RepoExplorerLocation):string{return `${location.path}\0${location.filePath??""}`}
const styles=StyleSheet.create({safeArea:{backgroundColor:"#08111E",flex:1},gestureSurface:{backgroundColor:"#08111E",flex:1,overflow:"hidden"},currentLayer:{backgroundColor:"#08111E",flex:1,shadowColor:"#000000",shadowOffset:{width:-3,height:0},shadowOpacity:0.28,shadowRadius:8},incomingLayer:{bottom:0,left:0,position:"absolute",right:0,top:0},incomingDim:{backgroundColor:"#000000",bottom:0,left:0,position:"absolute",right:0,top:0},navigationPage:{backgroundColor:"#08111E",flex:1},header:{alignItems:"center",borderBottomColor:"#20304C",borderBottomWidth:1,flexDirection:"row",gap:12,padding:14},headerCopy:{flex:1},title:{color:"#F5F7FB",fontSize:17,fontWeight:"800"},breadcrumb:{color:"#8398B8",fontSize:12},action:{color:"#73B7FF",fontSize:15,fontWeight:"700"},controls:{alignItems:"center",flexDirection:"row",gap:10,padding:12},filter:{backgroundColor:"#111C30",borderColor:"#263754",borderRadius:10,borderWidth:1,color:"#F5F7FB",flex:1,padding:10},toggle:{color:"#9EC8F0",fontSize:12,fontWeight:"700"},listContent:{flexGrow:1},row:{alignItems:"center",borderBottomColor:"#17243A",borderBottomWidth:1,flexDirection:"row",minHeight:50,paddingHorizontal:16},icon:{color:"#73B7FF",width:20},name:{color:"#E8EEF8",flex:1,fontSize:15},size:{color:"#7185A3",fontSize:12},loader:{padding:24},error:{color:"#FF9C9C",padding:16,textAlign:"center"},center:{alignItems:"center",flex:1,justifyContent:"center"},binaryTitle:{color:"#F5F7FB",fontSize:20,fontWeight:"800"},muted:{color:"#8398B8"},viewer:{flex:1},webView:{backgroundColor:"#08111E",flex:1}});
