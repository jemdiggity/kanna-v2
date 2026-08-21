<script setup lang="ts">
import { computed, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { usePortalSession } from "../session";

const props = withDefaults(defineProps<{
  result: "success" | "canceled";
  sessionId?: string | null;
}>(), {
  sessionId: null,
});
const session = usePortalSession();
const succeeded = computed(() => props.result === "success");

onMounted(() => {
  if (succeeded.value) void session.refreshEntitlement();
});
</script>

<template>
  <section class="card narrow">
    <p class="eyebrow">{{ succeeded ? "Welcome to Kanna Cloud" : "No charge was made" }}</p>
    <h1>{{ succeeded ? "Checkout complete" : "Checkout cancelled" }}</h1>
    <template v-if="succeeded">
      <p>Stripe accepted your checkout. Your account will show access as soon as the billing update arrives.</p>
      <p v-if="sessionId" class="quiet">Checkout reference: {{ sessionId }}</p>
    </template>
    <p v-else>Your account is unchanged. You can return to the plan whenever you're ready.</p>
    <RouterLink class="button" :to="succeeded ? '/account' : '/subscribe'">{{ succeeded ? "View account" : "Return to plan" }}</RouterLink>
  </section>
</template>
