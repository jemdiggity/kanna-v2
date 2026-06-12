export interface BonjourService {
  name: string;
  type: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

interface BonjourServiceEvent extends BonjourService {
  removed?: boolean;
}

interface BonjourRemovalEvent {
  name: string;
  type?: string;
  removed: true;
}

export interface BonjourBrowser {
  getServices(): readonly BonjourService[];
  start(): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
}

interface NativeBonjourModule {
  startBrowsing(): void;
  stopBrowsing(): void;
}

interface ReactNativeModule {
  NativeEventEmitter: new (nativeModule: object) => {
    addListener(
      eventName: string,
      listener: (event: unknown) => void
    ): { remove(): void };
  };
  NativeModules: { KannaBonjourModule?: NativeBonjourModule };
}

declare const require: ((id: string) => ReactNativeModule) | undefined;

export function createBonjourBrowser(): BonjourBrowser {
  const reactNative = loadReactNative();
  if (!reactNative) {
    return createStaticBonjourBrowser([]);
  }
  const { NativeEventEmitter, NativeModules } = reactNative;
  const nativeModule = NativeModules.KannaBonjourModule as NativeBonjourModule | undefined;
  if (!nativeModule) {
    return createStaticBonjourBrowser([]);
  }

  const services = new Map<string, BonjourService>();
  const listeners = new Set<() => void>();
  const emitter = new NativeEventEmitter(nativeModule as object);
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscription = emitter.addListener("kannaBonjourServiceChanged", (event) => {
    if (!applyBonjourServiceEvent(services, event)) {
      return;
    }
    notify();
  });

  return {
    getServices: () => Array.from(services.values()),
    start: () => nativeModule.startBrowsing(),
    stop() {
      nativeModule.stopBrowsing();
      subscription.remove();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function loadReactNative(): ReactNativeModule | null {
  try {
    return typeof require === "function" ? require("react-native") : null;
  } catch {
    return null;
  }
}

export function createStaticBonjourBrowser(
  initialServices: readonly BonjourService[]
): BonjourBrowser {
  const listeners = new Set<() => void>();
  return {
    getServices: () => initialServices,
    start() {},
    stop() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function applyBonjourServiceEvent(
  services: Map<string, BonjourService>,
  event: unknown
): boolean {
  const service = normalizeBonjourServiceEvent(event);
  if (!service) {
    return false;
  }

  const key = getBonjourServiceKey(service);
  if (service.removed === true) {
    const existed = services.delete(key);
    return existed;
  }

  services.set(key, service);
  return true;
}

function getBonjourServiceKey(service: Pick<BonjourService, "name">): string {
  return service.name;
}

function normalizeBonjourServiceEvent(
  event: unknown
): BonjourServiceEvent | BonjourRemovalEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Partial<BonjourServiceEvent>;
  if (record.removed === true) {
    return typeof record.name === "string"
      ? {
          name: record.name,
          type: typeof record.type === "string" ? record.type : undefined,
          removed: true
        }
      : null;
  }

  if (
    typeof record.name !== "string" ||
    typeof record.type !== "string" ||
    typeof record.host !== "string" ||
    typeof record.port !== "number"
  ) {
    return null;
  }

  return {
    name: record.name,
    type: record.type,
    host: record.host,
    port: record.port,
    txt: record.txt && typeof record.txt === "object" ? record.txt : {},
    removed: Boolean(record.removed)
  };
}
