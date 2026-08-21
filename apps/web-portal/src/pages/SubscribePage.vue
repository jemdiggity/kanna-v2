<script setup lang="ts">
import { ref } from "vue";
import { checkoutSessionRequest } from "../checkout";
import { formatCloudMonthlyPrice } from "../localizedPrice";
import { usePortalFirebase } from "../session";

const api = usePortalFirebase();
const props = withDefaults(defineProps<{ redirect?: (url: string) => void }>(), {
  redirect: (url: string) => window.location.assign(url)
});
const pending = ref(false);
const error = ref("");
const defaultConfiguredPrice = "$5/month";
const configuredPrice = import.meta.env.VITE_KANNA_CLOUD_PRICE?.trim();
const price = configuredPrice && configuredPrice !== defaultConfiguredPrice
  ? configuredPrice
  : `${formatCloudMonthlyPrice(navigator.language)}/month`;

async function subscribe(): Promise<void> {
  pending.value = true;
  error.value = "";
  try {
    const { url } = await api.createCheckoutSession(checkoutSessionRequest());
    if (!url) throw new Error("Stripe did not return a Checkout URL. Please try again.");
    props.redirect(url);
  } catch (caught: unknown) {
    error.value = caught instanceof Error ? caught.message : "Could not start Checkout.";
    pending.value = false;
  }
}
</script>

<template>
  <section class="card plan">
    <p class="eyebrow">Kanna Cloud</p>
    <h1>Work from anywhere</h1>
    <p class="price">{{ price }}</p>
    <p class="local-currency quiet">Charged in your local currency at checkout.</p>
    <p>Secure remote access to your Kanna desktop, cloud task index, and remote task controls.</p>
    <ul>
      <li>Cloud relay access</li>
      <li>Task status on mobile</li>
      <li>Remote task control</li>
    </ul>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button :disabled="pending" type="button" @click="subscribe">{{ pending ? "Opening Checkout…" : "Subscribe with Stripe" }}</button>
    <p class="quiet">Payment is completed securely on Stripe.</p>
  </section>
</template>
