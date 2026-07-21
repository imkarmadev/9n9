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
  --exclude='.initial-admin-password' \
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
ssh "${PI_TARGET}" "sudo -n bash -s -- '${PI_PATH}' '${PI_URL}'" <<'REMOTE_SECURITY_ENV'
set -Eeuo pipefail
project_path="$1"
public_origin="$2"
env_file="${project_path}/.env"
password_file="${project_path}/.initial-admin-password"
touch "${env_file}"
if ! grep -q '^N9N_MASTER_KEY=' "${env_file}"; then
  printf 'N9N_MASTER_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')" >> "${env_file}"
fi
if ! grep -q '^N9N_BOOTSTRAP_ADMIN_PASSWORD=' "${env_file}"; then
  admin_password="$(openssl rand -base64 24 | tr -d '\n')"
  printf 'N9N_BOOTSTRAP_ADMIN_USERNAME=admin\n' >> "${env_file}"
  printf 'N9N_BOOTSTRAP_ADMIN_PASSWORD=%s\n' "${admin_password}" >> "${env_file}"
  printf '%s' "${admin_password}" > "${password_file}"
fi
if [[ ! -f "${password_file}" ]]; then
  admin_password="$(sed -n 's/^N9N_BOOTSTRAP_ADMIN_PASSWORD=//p' "${env_file}" | head -n 1)"
  if [[ -n "${admin_password}" ]]; then printf '%s' "${admin_password}" > "${password_file}"; fi
fi
if ! grep -q '^N9N_PUBLIC_ORIGIN=' "${env_file}"; then
  printf 'N9N_PUBLIC_ORIGIN=%s\n' "${public_origin}" >> "${env_file}"
fi
chmod 600 "${env_file}"
if [[ -f "${password_file}" ]]; then chmod 600 "${password_file}"; fi
REMOTE_SECURITY_ENV

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

echo "==> Creating a short-lived deployment test session"
curl --fail --silent --show-error "${PI_URL}/" >/dev/null
N9N_DEPLOY_SESSION="$(
  ssh "${PI_TARGET}" "sudo -n docker exec 9n9 node /app/scripts/create-test-session.mjs"
)"
N9N_DEPLOY_SESSION_TOKEN="${N9N_DEPLOY_SESSION%%$'\n'*}"
N9N_DEPLOY_CSRF_TOKEN="${N9N_DEPLOY_SESSION#*$'\n'}"
if [[ -z "${N9N_DEPLOY_SESSION_TOKEN}" || -z "${N9N_DEPLOY_CSRF_TOKEN}" || "${N9N_DEPLOY_SESSION_TOKEN}" == "${N9N_DEPLOY_CSRF_TOKEN}" ]]; then
  echo "Could not create the deployment test session" >&2
  exit 1
fi

echo "==> Starting the isolated credential-redaction echo target"
ssh "${PI_TARGET}" "sudo -n docker rm -f 9n9-e2e-echo >/dev/null 2>&1 || true"
ssh "${PI_TARGET}" \
  "sudo -n docker run --detach --rm --name 9n9-e2e-echo --cap-drop ALL --security-opt no-new-privileges:true --publish 10099:10099 --entrypoint node 9n9-9n9 -e 'require(\"node:http\").createServer((request,response)=>{response.setHeader(\"content-type\",\"application/json\");response.end(JSON.stringify({authorization:request.headers.authorization}))}).listen(10099,\"0.0.0.0\")'" \
  >/dev/null
cleanup_echo() {
  ssh "${PI_TARGET}" "sudo -n docker rm -f 9n9-e2e-echo >/dev/null 2>&1 || true"
}
trap cleanup_echo EXIT
N9N_DEPLOY_ECHO_URL="${PI_URL%:*}:10099"

echo "==> Running browser tests against the deployed Pi"
N9N_E2E_SESSION_TOKEN="${N9N_DEPLOY_SESSION_TOKEN}" \
  N9N_E2E_CSRF_TOKEN="${N9N_DEPLOY_CSRF_TOKEN}" \
  N9N_E2E_ECHO_URL="${N9N_DEPLOY_ECHO_URL}" \
  PLAYWRIGHT_BASE_URL="${PI_URL}" npm run test:e2e
cleanup_echo
trap - EXIT
unset N9N_DEPLOY_SESSION N9N_DEPLOY_SESSION_TOKEN N9N_DEPLOY_CSRF_TOKEN N9N_DEPLOY_ECHO_URL

echo "==> 9n9 is deployed and healthy"
