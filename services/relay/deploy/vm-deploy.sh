#!/usr/bin/env bash
# Runs on kanna-relay-vm as root. Pulls the latest relay image and restarts the stack.
set -euo pipefail
cd "$(dirname "$0")"

# gcr.io pull auth: exchange the VM service account's metadata token for a docker login.
TOKEN=$(curl -fsS -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin https://gcr.io

docker compose pull
docker compose up -d
docker image prune -f
docker compose ps
