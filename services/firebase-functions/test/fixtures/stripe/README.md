# Stripe webhook fixture payloads

Hand-built samples in the shape the Stripe CLI delivers (`stripe listen`,
`stripe trigger`), covering the event types `stripeWebhook` handles plus one it
must ignore. They are **not** captures from a live account: no Stripe
credentials exist yet — that is a Slice-0 human item in
`docs/specs/accounts-and-billing.md` — so the whole webhook path is verified
against these payloads and the Firebase emulator.

Two shape notes that are easy to get wrong when adding fixtures:

- Subscriptions carry `current_period_end` on their **items** in the 2025+ API
  versions, not on the subscription object. `customer.subscription.*.json`
  follow the newer spelling; the handler reads both.
- Invoices carry the subscription reference under
  `parent.subscription_details.subscription` in the same versions. The
  `invoice.*.json` fixtures follow that; the handler again reads both.

When live test-mode keys land, re-capture these from `stripe trigger` output and
keep the assertions — that is exactly the check that Kanna reads the real shape.
