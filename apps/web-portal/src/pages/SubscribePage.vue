<script setup lang="ts">
import { ref } from "vue";
import { usePortalFirebase } from "../session";

const api = usePortalFirebase();
const props = withDefaults(defineProps<{ redirect?: (url: string) => void }>(), {
  redirect: (url: string) => window.location.assign(url)
});
const pending = ref(false);
const error = ref("");
/**
 * The headline price, and the same amount in every currency Kanna Cloud is sold
 * in (owner ruling, 2026-08-21 — see `docs/specs/accounts-and-billing.md`). One
 * build-time string plus a static list, deliberately: there is no locale
 * framework in the portal and one price per currency does not need one.
 */
const price = import.meta.env.VITE_KANNA_CLOUD_PRICE || "$5/month";
const currencies = ["¥500 JPY", "$5 USD", "$5 CAD", "$5 AUD", "€5 EUR", "£5 GBP"];

async function subscribe(): Promise<void> {
  pending.value = true;
  error.value = "";
  try {
    const { url } = await api.createCheckoutSession({
      successUrl: `${window.location.origin}/checkout/success`,
      cancelUrl: `${window.location.origin}/checkout/cancelled`
    });
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
    <p class="currencies quiet">The same price in every currency we sell in: {{ currencies.join(" · ") }} per month.</p>
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
