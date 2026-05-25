export interface DesktopAuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export type DesktopAuthState =
  | { status: "signedOut" }
  | { status: "signingIn"; user: DesktopAuthUser | null }
  | { status: "signedIn"; user: DesktopAuthUser }
  | { status: "error"; message: string; user: DesktopAuthUser | null };

export interface EmailPasswordSignInInput {
  email: string;
  password: string;
}

export interface DesktopAuthSdk {
  getCurrentUser(): DesktopAuthUser | null;
  onAuthStateChanged(listener: (user: DesktopAuthUser | null) => void): () => void;
  signInWithEmailPassword(email: string, password: string): Promise<DesktopAuthUser>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

export interface DesktopAuthSession {
  initialize(): Promise<void>;
  getState(): DesktopAuthState;
  subscribe(listener: (state: DesktopAuthState) => void): () => void;
  signInWithEmailPassword(input: EmailPasswordSignInInput): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

interface DesktopAuthSessionDeps {
  sdk: DesktopAuthSdk;
}

export function createDesktopAuthSession({
  sdk,
}: DesktopAuthSessionDeps): DesktopAuthSession {
  let state = normalizeUserState(sdk.getCurrentUser());
  let unsubscribeFromSdk: (() => void) | null = null;
  const listeners = new Set<(state: DesktopAuthState) => void>();

  const publish = (nextState: DesktopAuthState) => {
    state = nextState;
    for (const listener of listeners) listener(state);
  };

  const ensureSubscribed = () => {
    if (unsubscribeFromSdk) return;
    unsubscribeFromSdk = sdk.onAuthStateChanged((user) => {
      publish(normalizeUserState(user));
    });
  };

  return {
    async initialize() {
      ensureSubscribed();
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    async signInWithEmailPassword(input) {
      publish({
        status: "signingIn",
        user: state.status === "signedIn" ? state.user : null,
      });

      try {
        const user = await sdk.signInWithEmailPassword(input.email, input.password);
        publish({ status: "signedIn", user });
      } catch (error) {
        publish({
          status: "error",
          message: error instanceof Error ? error.message : "Sign-in failed",
          user: null,
        });
      }
    },
    async signOut() {
      await sdk.signOut();
      publish({ status: "signedOut" });
    },
    getIdToken(forceRefresh) {
      return sdk.getIdToken(forceRefresh);
    },
  };
}

export function createDisabledDesktopAuthSession(message: string): DesktopAuthSession {
  const sdk: DesktopAuthSdk = {
    getCurrentUser: () => null,
    onAuthStateChanged: (listener) => {
      listener(null);
      return () => undefined;
    },
    signInWithEmailPassword: async () => {
      throw new Error(message);
    },
    signOut: async () => undefined,
    getIdToken: async () => null,
  };

  return createDesktopAuthSession({ sdk });
}

function normalizeUserState(user: DesktopAuthUser | null): DesktopAuthState {
  return user ? { status: "signedIn", user } : { status: "signedOut" };
}
