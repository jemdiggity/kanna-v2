#!/usr/bin/env bash
# One-time provisioning of the kanna-relay VM in kanna-build.
# Idempotent: safe to re-run; existing resources are kept.
set -euo pipefail

PROJECT="${KANNA_RELAY_PROJECT:-kanna-build}"
REGION="${KANNA_CLOUD_RUN_REGION:-us-central1}"
ZONE="${KANNA_RELAY_VM_ZONE:-us-central1-a}"
VM_NAME="${KANNA_RELAY_VM_NAME:-kanna-relay-vm}"
SA_ID="kanna-relay-vm"
SA="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"

echo "==> Enabling Compute API"
gcloud services enable compute.googleapis.com --project "$PROJECT"

echo "==> Service account"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" --display-name "Kanna relay VM"
for i in $(seq 1 12); do
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 && break
  echo "    waiting for service account to propagate (${i}/12)..."
  sleep 5
done
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/datastore.user --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/artifactregistry.reader --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/storage.objectViewer --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/firebasecloudmessaging.admin --condition=None >/dev/null

echo "==> Static IP"
gcloud compute addresses describe kanna-relay-ip --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create kanna-relay-ip --project "$PROJECT" --region "$REGION"
IP=$(gcloud compute addresses describe kanna-relay-ip --project "$PROJECT" --region "$REGION" --format='value(address)')

echo "==> Firewall"
gcloud compute firewall-rules describe kanna-relay-allow-web --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create kanna-relay-allow-web \
       --project "$PROJECT" --direction INGRESS --action ALLOW \
       --rules tcp:80,tcp:443 --target-tags kanna-relay --source-ranges 0.0.0.0/0

echo "==> VM"
gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1 \
  || gcloud compute instances create "$VM_NAME" \
       --project "$PROJECT" --zone "$ZONE" \
       --machine-type e2-micro \
       --image-family debian-12 --image-project debian-cloud \
       --boot-disk-size 30GB --boot-disk-type pd-standard \
       --address "$IP" \
       --tags kanna-relay \
       --service-account "$SA" \
       --scopes cloud-platform \
       --metadata startup-script='#!/bin/bash
set -e
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi'

echo ""
echo "Provisioned. Static IP: $IP"
echo "Next: add DNS A record  relay.kanna.build -> $IP  at your DNS provider,"
echo "then run: ./kd cloud deploy --production --relay --ref <branch|tag|sha>"
