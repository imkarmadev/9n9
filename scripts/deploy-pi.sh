#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PI_TARGET="${N9N_PI_TARGET:-imkarma@192.168.1.95}"
PI_PATH="${N9N_PI_PATH:-/opt/9n9}"
PI_URL="${N9N_PI_URL:-http://192.168.1.95:9999}"

cd "${PROJECT_DIR}"

echo "==> Running the complete quality gate"
npm run check

echo "==> Syncing verified source to ${PI_TARGET}:${PI_PATH}"
rsync \
  --archive \
  --compress \
  --delete \
  --rsync-path="sudo -n rsync" \
  --exclude='.env' \
  --exclude='.git/' \
  --exclude='.next/' \
  --exclude='.test-data/' \
  --exclude='.vinext/' \
  --exclude='.wrangler/' \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='playwright-report/' \
  --exclude='test-results/' \
  ./ "${PI_TARGET}:${PI_PATH}/"

echo "==> Rebuilding the Pi service"
ssh "${PI_TARGET}" \
  "cd '${PI_PATH}' && sudo -n docker compose up -d --build --remove-orphans && sudo -n docker compose ps"

echo "==> Waiting for ${PI_URL}/api/status"
curl \
  --fail \
  --silent \
  --show-error \
  --retry 12 \
  --retry-all-errors \
  --retry-delay 2 \
  "${PI_URL}/api/status"
echo
echo "==> 9n9 is deployed and healthy"
