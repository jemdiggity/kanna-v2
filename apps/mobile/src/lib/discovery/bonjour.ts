export interface BonjourService {
  name: string;
  type: string;
  host: string;
  port: number;
  txt: Record<string, string>;
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
    const service = normalizeBonjourService(event);
    if (!service) {
      return;
    }
    services.set(`${service.name}:${service.host}:${service.port}`, service);
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

function normalizeBonjourService(event: unknown): BonjourService | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Partial<BonjourService>;
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
    txt: record.txt && typeof record.txt === "object" ? record.txt : {}
  };
}
