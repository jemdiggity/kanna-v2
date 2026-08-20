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

async function register(): Promise<void> {
  pending.value = true;
  error.value = "";
  try {
    await api.register(email.value, password.value);
    await router.push("/verify-email");
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : "Could not create your account.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="card narrow">
    <p class="eyebrow">Kanna Cloud</p>
    <h1>Create your account</h1>
    <p>Use an email address you can verify.</p>
    <form @submit.prevent="register">
      <label>Email <input v-model="email" required type="email" autocomplete="email" /></label>
      <label>Password <input v-model="password" required minlength="6" type="password" autocomplete="new-password" /></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button :disabled="pending" type="submit">{{ pending ? "Creating…" : "Create account" }}</button>
    </form>
    <p class="quiet">Already registered? <RouterLink to="/sign-in">Sign in</RouterLink></p>
  </section>
</template>
