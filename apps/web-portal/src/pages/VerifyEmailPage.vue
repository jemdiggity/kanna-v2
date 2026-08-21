<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { usePortalFirebase, usePortalSession } from "../session";

const session = usePortalSession();
const api = usePortalFirebase();
const router = useRouter();
const checking = ref(false);
const message = ref("");
let pollTimer: number | undefined;
let verified = false;

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function checkVerification(showUnverifiedMessage = true): Promise<void> {
  if (!session.user.value || checking.value || verified) return;
  checking.value = true;
  try {
    const user = await api.reloadUser(session.user.value);
    session.user.value = user;
    if (user.emailVerified) {
      verified = true;
      stopPolling();
      await router.push("/subscribe");
    } else if (showUnverifiedMessage) {
      message.value = "That address is not verified yet. Open the link in your email, then try again.";
    }
  } catch (caught: unknown) {
    console.error("Could not refresh email verification state", caught);
    if (showUnverifiedMessage) {
      message.value = caught instanceof Error ? caught.message : "Could not check verification. Please try again.";
    }
  } finally {
    checking.value = false;
  }
}

function checkAfterFocus(): void {
  void checkVerification(false);
}

function checkManually(): void {
  void checkVerification();
}

onMounted(() => {
  pollTimer = window.setInterval(() => void checkVerification(false), 3_000);
  window.addEventListener("focus", checkAfterFocus);
});

onUnmounted(() => {
  stopPolling();
  window.removeEventListener("focus", checkAfterFocus);
});
</script>

<template>
  <section class="card narrow">
    <p class="eyebrow">One more step</p>
    <h1>Verify your email</h1>
    <p>We sent a verification link to <strong>{{ session.user.value?.email }}</strong>.</p>
    <p>Open the link, then return here to continue.</p>
    <p v-if="message" class="error" role="status">{{ message }}</p>
    <button :disabled="checking" type="button" @click="checkManually">{{ checking ? "Checking…" : "I verified my email" }}</button>
  </section>
</template>
