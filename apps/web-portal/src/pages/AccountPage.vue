<script setup lang="ts">
import { RouterLink } from "vue-router";
import { usePortalSession } from "../session";

const session = usePortalSession();
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
</template>
