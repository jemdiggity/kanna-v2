# Self-hosting the Kanna relay

> **Status (2026-09-03): the mobile custom relay endpoint control is hidden in shipped builds.** It exists only in `dev` builds; App Store and TestFlight users cannot reach it, and a relay URL stored on a device before this change is ignored by those builds (the stored value is left alone, so it returns if the control is restored). Self-hosting therefore currently requires building the mobile and desktop clients against your own Firebase project — see "Authentication and subscription boundary" for why. The feature is hidden, not removed: `CUSTOM_RELAY_CONTROL_APP_ENVS` in `apps/mobile/src/relaySettings.ts` is the single switch that restores it.

Kanna's mobile and desktop clients can use `services/relay` at an operator-owned endpoint. A self-hosted relay keeps the same Firebase authentication as Kanna's hosted relays, but it does not require a Kanna Cloud entitlement when entitlement enforcement is left off.

## Authentication and subscription boundary

The relay authenticates a phone with its Firebase ID token and a desktop with the `desktopCredentials/{desktopId}` secret-hash record. Both identities must resolve to the same Firebase uid before the relay routes traffic. A custom endpoint does not disable or replace either check. Direct LAN access separately requires desktop pairing for all data routes; only status discovery and pairing/authentication bootstrap are public. Loopback desktop access is unchanged.

The separate `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT` setting gates subscriptions. It defaults to `off`; keep it off for self-hosted service so authenticated accounts work whether or not they subscribe to Kanna Cloud. Kanna's hosted deployments control their own value for this setting, and choosing a custom URL on a phone cannot change hosted-relay policy.

The relay's Firebase Admin configuration must target the same Firebase project as the Kanna mobile and desktop builds being connected. Set `FIREBASE_PROJECT_ID` and provide Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS_JSON` with access to that project's Firestore data. A stock production or staging app cannot authenticate against a relay backed by an unrelated Firebase project; a self-hosted deployment needs authorized Admin credentials for the app's project. Firebase identity is a prerequisite, not a Kanna Cloud subscription check.

## Run the relay

For local development, install the repository dependencies and start the service with the required Firebase environment:

```sh
pnpm install --frozen-lockfile
FIREBASE_PROJECT_ID=your-firebase-project \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
KANNA_RELAY_ENTITLEMENT_ENFORCEMENT=off \
PORT=8080 \
pnpm --dir services/relay dev
```

For a durable deployment, build `services/relay/Dockerfile` and place it behind a WebSocket-capable TLS reverse proxy. `services/relay/deploy/Caddyfile` and `docker-compose.yml` show the production topology. A source-only relay does not need OTA signing configuration; the provided compose topology also serves OTA updates and therefore declares those variables.

Verify the public endpoint before changing clients:

```sh
curl https://relay.example.com/health
```

The response should report `"status":"ok"`.

## Point both clients at it

1. Stop `kanna-server`, edit its active `server.toml`, set `relay_url = "wss://relay.example.com"`, and restart the desktop app/server. Use the active instance's config path; development worktrees, staging, and production each have a separate file.
2. On mobile, point the build at the relay. **A shipped (staging or production) build has no user-facing control for this**; its relay comes from `relayUrl` in `apps/mobile/src/mobileEnvironments.json` (or `EXPO_PUBLIC_KANNA_RELAY_URL` at build time), so self-hosting means building the app yourself against your own Firebase project and relay. In a `dev` build the runtime control is still present: open Account, find **Relay connection**, enter the same `wss://` URL, and tap **Use custom relay**. The app closes existing relay sockets and reconnects through the custom endpoint immediately.
3. In a `dev` build, confirm the Account sheet says **Using custom relay**. **Reset to default** returns to the relay baked into the mobile environment and reconnects without an app restart.

The mobile override is stored on that device, and is only honored by builds where the control is shown. It affects relay control sockets, task streams, reconnects, and signed-in push registration; it does not change LAN discovery or the Firebase project configured in the app build.

## TLS requirement

Use `wss://` with a publicly valid certificate whose hostname matches the relay URL. iOS App Transport Security effectively requires this for a user-configured internet endpoint; a self-signed certificate or bare `ws://` endpoint is rejected by the settings validation and should only be used by the repository's controlled development harness.
