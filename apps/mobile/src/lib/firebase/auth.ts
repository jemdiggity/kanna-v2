export interface MobileAuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified?: boolean;
  cloudAccess?: "active" | "inactive" | "unknown";
}

export type MobileAuthState =
  | { status: "signedOut" }
  | { status: "signingIn"; user: MobileAuthUser | null }
  | { status: "signedIn"; user: MobileAuthUser }
  | { status: "error"; message: string; user: MobileAuthUser | null };

export interface EmailPasswordSignInInput {
  email: string;
  password: string;
}

export interface MobileAuthSdk {
  getCurrentUser(): MobileAuthUser | null;
  onAuthStateChanged(listener: (user: MobileAuthUser | null) => void): () => void;
  signInWithEmailPassword(email: string, password: string): Promise<MobileAuthUser>;
  createUserWithEmailPassword(email: string, password: string): Promise<MobileAuthUser>;
  reloadUser(): Promise<MobileAuthUser | null>;
  getCloudAccess(uid: string): Promise<"active" | "inactive" | "unknown">;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

export interface MobileAuthSession {
  initialize(): Promise<void>;
  getState(): MobileAuthState;
  subscribe(listener: (state: MobileAuthState) => void): () => void;
  signInWithEmailPassword(input: EmailPasswordSignInInput): Promise<void>;
  createUserWithEmailPassword(input: EmailPasswordSignInInput): Promise<void>;
  refreshAccount(): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  /** Mark the session as expired after the relay rejected the ID token even
   * after a forced refresh. Surfaces an auth error and requires re-login. */
  notifyAuthExpired(): void;
}

const AUTH_EXPIRED_MESSAGE = "Your session expired. Please sign in again.";

interface MobileAuthSessionDeps {
  sdk: MobileAuthSdk;
}

export function createMobileAuthSession({
  sdk
}: MobileAuthSessionDeps): MobileAuthSession {
  let state: MobileAuthState = normalizeUserState(sdk.getCurrentUser());
  let initialAuthPromise: Promise<void> | null = null;
  const listeners = new Set<(state: MobileAuthState) => void>();

  const publish = (nextState: MobileAuthState) => {
    state = nextState;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const waitForInitialAuth = () => {
    if (initialAuthPromise) {
      return initialAuthPromise;
    }

    let resolveInitialAuth!: () => void;
    let rejectInitialAuth!: (reason?: unknown) => void;
    initialAuthPromise = new Promise<void>((resolve, reject) => {
      resolveInitialAuth = resolve;
      rejectInitialAuth = reject;
    });

    try {
      sdk.onAuthStateChanged((user) => {
        publish(normalizeUserState(user));
        resolveInitialAuth();
        if (user) {
          void loadAccountState(user).then((loadedUser) => {
            const currentUser = state.status === "signedIn" ? state.user : null;
            if (currentUser?.uid === loadedUser.uid) {
              publish({ status: "signedIn", user: loadedUser });
            }
          }).catch((error: unknown) => {
            console.error("Could not refresh restored account state:", error);
          });
        }
      });
    } catch (error) {
      rejectInitialAuth(error);
    }

    return initialAuthPromise;
  };

  async function loadAccountState(
    user: MobileAuthUser
  ): Promise<MobileAuthUser> {
    const refreshed = (await sdk.reloadUser()) ?? user;
    if (refreshed.emailVerified === false) {
      return { ...refreshed, cloudAccess: "inactive" };
    }
    if (user.emailVerified === false && refreshed.emailVerified === true) {
      // Firebase caches ID tokens independently from the mutable User record.
      // Renew before publishing the verified state so relay clients created by
      // that state transition cannot inherit an email_verified=false claim.
      await sdk.getIdToken(true);
    }
    return {
      ...refreshed,
      cloudAccess: await sdk.getCloudAccess(refreshed.uid)
    };
  }

  return {
    initialize() {
      return waitForInitialAuth();
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
        user: state.status === "signedIn" ? state.user : null
      });

      try {
        const user = await sdk.signInWithEmailPassword(input.email, input.password);
        publish({ status: "signedIn", user: await loadAccountState(user) });
      } catch (error) {
        publish({
          status: "error",
          message: error instanceof Error ? error.message : "Sign-in failed",
          user: null
        });
      }
    },
    async createUserWithEmailPassword(input) {
      publish({ status: "signingIn", user: null });
      try {
        const user = await sdk.createUserWithEmailPassword(input.email, input.password);
        publish({
          status: "signedIn",
          user: user.emailVerified === false
            ? { ...user, cloudAccess: "inactive" }
            : await loadAccountState(user)
        });
      } catch (error) {
        publish({
          status: "error",
          message: error instanceof Error ? error.message : "Account creation failed",
          user: null
        });
      }
    },
    async refreshAccount() {
      const user = state.status === "signedIn" || state.status === "error"
        ? state.user
        : null;
      if (!user) return;
      try {
        publish({ status: "signedIn", user: await loadAccountState(user) });
      } catch (error) {
        publish({
          status: "error",
          message: error instanceof Error ? error.message : "Could not refresh account",
          user
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
    notifyAuthExpired() {
      // Only meaningful while we believe we are signed in; ignore otherwise so a
      // stray late callback can't clobber a clean signed-out state.
      if (state.status === "signedOut") {
        return;
      }
      publish({
        status: "error",
        message: AUTH_EXPIRED_MESSAGE,
        user: state.user
      });
    }
  };
}

export function createDisabledMobileAuthSession(): MobileAuthSession {
  const sdk: MobileAuthSdk = {
    getCurrentUser: () => null,
    onAuthStateChanged: (listener) => {
      listener(null);
      return () => undefined;
    },
    signInWithEmailPassword: async () => {
      throw new Error("Firebase Auth is not configured.");
    },
    createUserWithEmailPassword: async () => {
      throw new Error("Firebase Auth is not configured.");
    },
    reloadUser: async () => null,
    getCloudAccess: async () => "unknown",
    signOut: async () => undefined,
    getIdToken: async () => null
  };

  return createMobileAuthSession({ sdk });
}

function normalizeUserState(user: MobileAuthUser | null): MobileAuthState {
  return user ? { status: "signedIn", user } : { status: "signedOut" };
}
