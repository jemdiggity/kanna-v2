<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { usePortalFirebase, usePortalSession } from "../session";

const session = usePortalSession();
const api = usePortalFirebase();
const router = useRouter();
const checking = ref(false);
const message = ref("");

async function checkVerification(): Promise<void> {
  if (!session.user.value) return;
  checking.value = true;
  const user = await api.reloadUser(session.user.value);
  if (user.emailVerified) await router.push("/subscribe");
  else message.value = "That address is not verified yet. Open the link in your email, then try again.";
  checking.value = false;
}
</script>

<template>
  <section class="card narrow">
    <p class="eyebrow">One more step</p>
    <h1>Verify your email</h1>
    <p>We sent a verification link to <strong>{{ session.user.value?.email }}</strong>.</p>
    <p>Open the link, then return here to continue.</p>
    <p v-if="message" class="error" role="status">{{ message }}</p>
    <button :disabled="checking" type="button" @click="checkVerification">{{ checking ? "Checking…" : "I verified my email" }}</button>
  </section>
</template>
