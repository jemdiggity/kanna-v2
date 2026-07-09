# Mobile OTA Server E2E Gap

This branch implements the relay and publish side of self-hosted mobile OTA updates. A full device E2E cannot be completed in this branch alone because the sibling client task owns `expo-updates` runtime integration in `apps/mobile`.

Server-side coverage added here verifies manifest generation, code signing, local-storage relay integration, asset streaming, kd publish planning, and deploy secret wiring. After publishing, run the kd-managed read-only cloud and relay preflight with Google Cloud credentials for the target project:

```bash
./kd mobile ota publish --staging
./kd mobile ota doctor --staging
```

Post-merge human device verification remains:

```bash
./kd mobile run --device --staging
```

Use `./kd mobile run --device --staging --install` instead when verifying a bundled staging Release install without Metro/hot loading. Then confirm the staging app fetches and applies the update, change a visible JS string, republish, and confirm the replacement update applies on foreground or restart.
