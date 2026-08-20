<script setup lang="ts">
import { computed, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { usePortalSession } from "../session";

const props = defineProps<{ result: "success" | "cancelled" }>();
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
    <p v-if="succeeded">Stripe accepted your checkout. Your account will show access as soon as the billing update arrives.</p>
    <p v-else>Your account is unchanged. You can return to the plan whenever you're ready.</p>
    <RouterLink class="button" :to="succeeded ? '/account' : '/subscribe'">{{ succeeded ? "View account" : "Return to plan" }}</RouterLink>
  </section>
</template>
