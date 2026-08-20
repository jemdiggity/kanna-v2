<script setup lang="ts">
import { watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { authRedirect } from "./router";
import { providePortalSession, usePortalFirebase } from "./session";

const session = providePortalSession();
const api = usePortalFirebase();
const route = useRoute();
const appRouter = useRouter();

watch(
  [session.ready, session.user, session.subscribed, () => route.fullPath],
  () => {
    if (!session.ready.value) return;
    const destination = authRedirect(route, {
      signedIn: Boolean(session.user.value),
      emailVerified: session.user.value?.emailVerified ?? false,
      subscribed: session.subscribed.value
    });
    if (destination) void appRouter.replace(destination);
  },
  { immediate: true }
);

async function leave(): Promise<void> {
  await api.signOut();
  await appRouter.push("/sign-in");
}
</script>

<template>
  <header class="site-header">
    <RouterLink class="brand" to="/account">Kanna</RouterLink>
    <nav>
      <template v-if="session.user.value">
        <RouterLink to="/account">Account</RouterLink>
        <button class="link-button" type="button" @click="leave">Sign out</button>
      </template>
      <template v-else>
        <RouterLink to="/sign-in">Sign in</RouterLink>
        <RouterLink to="/register">Create account</RouterLink>
      </template>
    </nav>
  </header>
  <main>
    <p v-if="!session.ready.value" class="card">Loading your account…</p>
    <RouterView v-else />
  </main>
</template>
