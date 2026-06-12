# Relay VM Operations

This runbook provisions and deploys the Kanna relay VM for staging or production. Do not run these steps until the target environment and DNS change are approved.

## Staging

1. Build the provisioning plan:

   ```bash
   ./kd cloud relay-provision --staging
   ```

2. Run the first command from the plan to reserve the static IP in `kanna-staging`.

3. Add a GoDaddy DNS A record:

   ```text
   relay-staging.kanna.build -> <reserved IP>
   ```

4. Wait for DNS to resolve. Caddy cannot obtain a Let's Encrypt certificate until `relay-staging.kanna.build` resolves to the VM IP.

5. Run the remaining provision commands from the plan to create the VM and firewall rule.

6. Add the staging Firebase service account JSON to `/opt/kanna-relay/.env` on the VM:

   ```bash
   sudo install -d -m 0755 /opt/kanna-relay
   sudo sh -c 'printf "%s\n" "GOOGLE_APPLICATION_CREDENTIALS_JSON=<service-account-json>" >> /opt/kanna-relay/.env'
   ```

7. Deploy the relay:

   ```bash
   ./kd cloud deploy --staging --relay
   ```

8. Wire staging apps to:

   ```text
   KANNA_CLOUD_ENV=staging
   EXPO_PUBLIC_KANNA_RELAY_URL=wss://relay-staging.kanna.build
   ```

## Production

Production is the existing VM-backed relay:

```text
relay.kanna.build -> 34.133.233.111
project: kanna-build
```

Use the production plan only when intentionally changing production infrastructure:

```bash
./kd cloud relay-provision --production
./kd cloud deploy --production --relay
```
