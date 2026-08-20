import { computed, inject, provide, readonly, ref, shallowRef, type ComputedRef, type InjectionKey, type Ref, type ShallowRef } from "vue";
import type { User } from "firebase/auth";
import { portalFirebase, type PortalFirebase } from "./firebase";
import type { CloudEntitlement } from "./types";

export interface PortalSession {
  user: ShallowRef<User | null>;
  entitlement: ShallowRef<CloudEntitlement | null>;
  ready: Readonly<Ref<boolean>>;
  subscribed: Readonly<ComputedRef<boolean>>;
  refreshEntitlement(): Promise<void>;
}

const sessionKey: InjectionKey<PortalSession> = Symbol("portal-session");
const firebaseKey: InjectionKey<PortalFirebase> = Symbol("portal-firebase");

export function providePortalSession(api: PortalFirebase = portalFirebase): PortalSession {
  const user = shallowRef<User | null>(null);
  const entitlement = shallowRef<CloudEntitlement | null>(null);
  const ready = ref(false);

  async function refreshEntitlement(): Promise<void> {
    entitlement.value = user.value ? await api.entitlement(user.value.uid) : null;
  }

  api.observeUser((nextUser) => {
    user.value = nextUser;
    void refreshEntitlement().finally(() => { ready.value = true; });
  });
  const subscribed = computed(() => entitlement.value?.status === "active" || entitlement.value?.status === "grace");

  const session: PortalSession = {
    user,
    entitlement,
    ready: readonly(ready),
    subscribed,
    refreshEntitlement
  };
  provide(sessionKey, session);
  provide(firebaseKey, api);
  return session;
}

export function usePortalSession(): PortalSession {
  const session = inject(sessionKey);
  if (!session) throw new Error("Portal session has not been provided");
  return session;
}

export function usePortalFirebase(): PortalFirebase {
  const api = inject(firebaseKey);
  if (!api) throw new Error("Portal Firebase API has not been provided");
  return api;
}
