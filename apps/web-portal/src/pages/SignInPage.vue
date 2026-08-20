<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { usePortalFirebase } from "../session";

const api = usePortalFirebase();
const router = useRouter();
const email = ref("");
const password = ref("");
const error = ref("");
const pending = ref(false);

async function signIn(): Promise<void> {
  pending.value = true;
  error.value = "";
  try {
    const user = await api.signIn(email.value, password.value);
    await router.push(user.emailVerified ? "/account" : "/verify-email");
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : "Could not sign in.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="card narrow">
    <p class="eyebrow">Welcome back</p>
    <h1>Sign in</h1>
    <form @submit.prevent="signIn">
      <label>Email <input v-model="email" required type="email" autocomplete="email" /></label>
      <label>Password <input v-model="password" required type="password" autocomplete="current-password" /></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button :disabled="pending" type="submit">{{ pending ? "Signing in…" : "Sign in" }}</button>
    </form>
    <p class="quiet">New to Kanna? <RouterLink to="/register">Create an account</RouterLink></p>
  </section>
</template>
