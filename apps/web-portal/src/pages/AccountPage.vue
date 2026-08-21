<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { usePortalFirebase, usePortalSession } from "../session";

const session = usePortalSession();
const api = usePortalFirebase();
const deleting = ref(false);
const confirmation = ref("");
const pending = ref(false);
const error = ref("");

async function deleteAccount(): Promise<void> {
  if (confirmation.value !== "DELETE") return;
  pending.value = true;
  error.value = "";
  try {
    await api.deleteAccount();
    await api.signOut();
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : "Could not delete your account.";
    pending.value = false;
  }
}
</script>

<template>
  <section class="card">
    <p class="eyebrow">Your account</p>
    <h1>{{ session.user.value?.email }}</h1>
    <div class="status-row">
      <span>Cloud access</span>
      <strong :class="session.subscribed.value ? 'active' : 'inactive'">
        {{ session.entitlement.value?.status ?? "inactive" }}
      </strong>
    </div>
    <template v-if="session.subscribed.value">
      <p>Your Kanna Cloud subscription is ready.</p>
      <p class="quiet">Source: {{ session.entitlement.value?.source }}</p>
    </template>
    <template v-else>
      <p>This account does not currently have Kanna Cloud access.</p>
      <RouterLink class="button" to="/subscribe">Choose a plan</RouterLink>
    </template>
  </section>
  <section class="card danger-zone">
    <p class="eyebrow danger-text">Danger zone</p>
    <h2>Delete account</h2>
    <p>Permanently remove your Kanna Cloud account.</p>
    <button v-if="!deleting" class="danger-button" type="button" @click="deleting = true">Delete account</button>
    <form v-else class="delete-confirmation" @submit.prevent="deleteAccount">
      <p>Your subscription is canceled immediately. Your cloud data and cloud desktop pairings are permanently deleted. Local Kanna data and LAN pairings remain. There is no undo.</p>
      <label>Type DELETE to continue <input v-model="confirmation" autocomplete="off" /></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="confirmation-actions">
        <button class="link-button" :disabled="pending" type="button" @click="deleting = false">Cancel</button>
        <button class="danger-button" :disabled="confirmation !== 'DELETE' || pending" type="submit">{{ pending ? "Deleting…" : "Delete permanently" }}</button>
      </div>
    </form>
  </section>
</template>
