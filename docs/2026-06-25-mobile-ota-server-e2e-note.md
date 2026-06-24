# Mobile OTA Server E2E Gap

This branch implements the relay and publish side of self-hosted mobile OTA updates. A full device E2E cannot be completed in this branch alone because the sibling client task owns `expo-updates` runtime integration in `apps/mobile`.

Server-side coverage added here verifies manifest generation, code signing, local-storage relay integration, asset streaming, kd publish planning, and deploy secret wiring. Post-merge human verification remains:

```bash
./kd mobile ota publish --staging
./kd mobile run --device --staging
```

Then confirm the staging app fetches and applies the update, change a visible JS string, republish, and confirm the replacement update applies on foreground or restart.
