#!/bin/bash
# Run YOUR FORK of Gemini CLI with the official internal proxy.
# Replicates what /google/bin/releases/gemini-cli/tools/gemini does,
# but points at your local build instead of the release Node.js bundle.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PID=""
PORT_FILE=$(mktemp -t gemini_api_proxy_port.XXXXXXXXXX)
EXPERIMENTS_FILE=$(mktemp -t gemini_cli_experiments.XXXXXXXXXX)

# The official release proxy binary
PROXY_BINARY="/google/bin/releases/gemini-cli/tools/gemini_api_proxy"

cleanup() {
  [[ -n "${PROXY_PID}" ]] && kill -TERM "${PROXY_PID}" 2>/dev/null || true
  rm -f "${PORT_FILE}" "${EXPERIMENTS_FILE}"
}
trap cleanup EXIT

# Build the CLI
echo "Building Gemini CLI (your fork)..."
cd "${SCRIPT_DIR}"
npm run build --silent 2>/dev/null

# Start the official proxy in background
echo "Starting internal proxy..."
"${PROXY_BINARY}" \
  --port 0 \
  --port_file="${PORT_FILE}" \
  --genai_backend="blade:google.ai.generativelanguage.v1main.generativeservice-prod" \
  --project="shared-g3-gemini-quota" \
  --enable_sawmill_logging=true \
  --experiments_file="${EXPERIMENTS_FILE}" \
  --credential_exchanger_call_gaia_client_with_compass_stub_task_percentage=0 \
  &
PROXY_PID=$!

# Wait for proxy port
echo -n "Waiting for proxy..."
for i in $(seq 1 60); do
  if [[ -s "${PORT_FILE}" ]]; then break; fi
  echo -n "."
  sleep 0.5
done
echo ""

PROXY_PORT=$(cat "${PORT_FILE}")
if [[ -z "${PROXY_PORT}" ]]; then
  echo "ERROR: Proxy failed to start"
  exit 1
fi
echo "Proxy ready on port ${PROXY_PORT}"

# Wait for experiments
for i in $(seq 1 20); do
  [[ -s "${EXPERIMENTS_FILE}" ]] && break
  sleep 0.2
done
[[ ! -s "${EXPERIMENTS_FILE}" ]] && echo "{}" > "${EXPERIMENTS_FILE}"

# Set env vars (same as wrapper.sh lines 375-385)
export GOOGLE_GEMINI_BASE_URL="http://localhost:${PROXY_PORT}"
export GEMINI_API_KEY="api_proxy:shared-g3-gemini-quota"
export GEMINI_EXP="${EXPERIMENTS_FILE}"
export GEMINI_TELEMETRY_ENABLED=true
export GEMINI_TELEMETRY_TARGET=local
export GEMINI_TELEMETRY_OTLP_PROTOCOL=http
export GEMINI_TELEMETRY_OTLP_ENDPOINT="http://localhost:${PROXY_PORT}/logevent"

echo "Launching Gemini CLI (your fork) with internal proxy..."
echo "---"
node --no-deprecation "${SCRIPT_DIR}/packages/cli/dist/index.js" "$@"
