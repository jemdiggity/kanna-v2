# Self-Hosted OTA Updates for Kanna Mobile

Kanna mobile uses self-hosted Expo Updates for staging and production JS/asset
updates. Development builds remain Metro/dev-client only.

## Client Scope

- `expo-updates` is configured only when `KANNA_APP_ENV` is `staging` or `prod`.
- The manifest URL is derived from the environment relay URL by converting
  `wss://` to `https://` and appending `/ota/manifest`.
- The app checks after initial model initialization and on foreground, throttled
  to once every five minutes.
- Downloaded updates do not reload active sessions immediately. The app shows
  an in-app prompt and also reloads on the next foreground after backgrounding.

## Shared Contract

- Protocol: Expo Updates protocol version 1, platform `ios`.
- Manifest endpoint: `GET /ota/manifest`.
- Asset endpoint: `GET /ota/assets?key=<hash>&runtimeVersion=<rv>&platform=ios`.
- Origins: `https://relay-staging.kanna.build` and `https://relay.kanna.build`.
- Dev: disabled.
- Channels: `staging`, `production`.
- Channel header: `expo-channel-name`.
- runtimeVersion source: `apps/mobile/src/mobileEnvironments.json`.
- Code signing: RSA, `alg` `rsa-v1_5-sha256`.
- keyid: `kanna-mobile-ota-v1`.
- Public cert path: `apps/mobile/certs/ota-codesign.pem`.

The certificate file is currently a TODO placeholder. The server/publish task
must replace it with the real public certificate for keyid
`kanna-mobile-ota-v1` before staging or production OTA builds are released.
