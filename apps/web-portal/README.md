# Kanna account portal

Vue/Firebase account and Stripe Checkout funnel for Kanna Cloud. Local browser configuration is documented in `.env.example`; copy it to an untracked `.env.local` and use the Firebase emulators for development.

`./kd cloud deploy --staging` builds and deploys this app with the rest of the Firebase surface. Cloud deploys require these environment variables:

- `KANNA_WEB_PORTAL_FIREBASE_API_KEY`
- `KANNA_WEB_PORTAL_FIREBASE_APP_ID`
- `KANNA_WEB_PORTAL_STRIPE_PUBLISHABLE_KEY`

Optional overrides are `KANNA_WEB_PORTAL_FIREBASE_AUTH_DOMAIN`, `KANNA_WEB_PORTAL_FIREBASE_FUNCTIONS_REGION`, and `KANNA_WEB_PORTAL_CLOUD_PRICE`. These are public browser identifiers/display configuration, not server secrets. Stripe secret keys remain in the Functions secret store.

The integration command starts its own Auth emulator. Until the billing backend lands, the test harness serves a test-only `createCheckoutSession` callable stub on the reserved Functions port. The harness uses this worktree's reserved `KANNA_FIREBASE_*_PORT` values and falls back to the standard Firebase emulator ports outside a Kanna task:

```sh
pnpm --dir apps/web-portal test:integration
```
