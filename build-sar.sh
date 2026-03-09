#!/bin/bash
# Build a self-extracting archive for your Gemini CLI fork.
# Uses the esbuild bundle for fast startup (~1s vs ~2s with unbundled dist/).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="${SCRIPT_DIR}/dist/gemini-internal"
STAGING_DIR=$(mktemp -d)

echo "=== Building Gemini CLI SAR package ==="

# Step 1: Build (both dist/ and bundle/)
echo "[1/4] Building CLI..."
cd "${SCRIPT_DIR}"
npm run build --silent 2>/dev/null

# Step 2: Stage — use the single-file esbuild bundle for fast startup
echo "[2/4] Staging files..."

# The bundle is a single ESM file with all dependencies inlined
cp bundle/gemini.js "${STAGING_DIR}/gemini.js"

# Copy WASM files that can't be inlined by esbuild
if ls bundle/*.wasm 2>/dev/null 1>&2; then
  cp bundle/*.wasm "${STAGING_DIR}/"
fi

# Step 3: Create wrapper
echo "[3/4] Creating wrapper..."
cat > "${STAGING_DIR}/run.sh" << 'WRAPPER_EOF'
#!/bin/bash
set -e
RUNDIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PID=""
PORT_FILE=$(mktemp -t gemini_api_proxy_port.XXXXXXXXXX)
EXPERIMENTS_FILE=$(mktemp -t gemini_cli_experiments.XXXXXXXXXX)
PROXY_BINARY="/google/bin/releases/gemini-cli/tools/gemini_api_proxy"

cleanup() {
  [[ -n "${PROXY_PID}" ]] && kill -TERM "${PROXY_PID}" 2>/dev/null || true
  rm -f "${PORT_FILE}" "${EXPERIMENTS_FILE}"
}
trap cleanup EXIT

"${PROXY_BINARY}" \
  --port 0 \
  --port_file="${PORT_FILE}" \
  --genai_backend="blade:google.ai.generativelanguage.v1main.generativeservice-prod" \
  --project="shared-g3-gemini-quota" \
  --enable_sawmill_logging=true \
  --experiments_file="${EXPERIMENTS_FILE}" \
  --credential_exchanger_call_gaia_client_with_compass_stub_task_percentage=0 \
  2>/dev/null &
PROXY_PID=$!

for i in $(seq 1 60); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.5; done
PROXY_PORT=$(cat "${PORT_FILE}" 2>/dev/null)
[[ -z "${PROXY_PORT}" ]] && echo "ERROR: Proxy failed to start" >&2 && exit 1

for i in $(seq 1 20); do [[ -s "${EXPERIMENTS_FILE}" ]] && break; sleep 0.2; done
[[ ! -s "${EXPERIMENTS_FILE}" ]] && echo "{}" > "${EXPERIMENTS_FILE}"

export GOOGLE_GEMINI_BASE_URL="http://localhost:${PROXY_PORT}"
export GEMINI_API_KEY="api_proxy:shared-g3-gemini-quota"
export GEMINI_EXP="${EXPERIMENTS_FILE}"
export GEMINI_TELEMETRY_ENABLED=true
export GEMINI_TELEMETRY_TARGET=local
export GEMINI_TELEMETRY_OTLP_PROTOCOL=http
export GEMINI_TELEMETRY_OTLP_ENDPOINT="http://localhost:${PROXY_PORT}/logevent"

exec node --no-deprecation "${RUNDIR}/gemini.js" "$@"
WRAPPER_EOF
chmod +x "${STAGING_DIR}/run.sh"

# Step 4: Package
echo "[4/4] Packaging SAR..."
mkdir -p "${SCRIPT_DIR}/dist"

cat > "${OUTPUT}" << 'STUB_EOF'
#!/bin/bash
set -e
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HASH=$(md5sum "$SELF" 2>/dev/null | cut -c1-12 || echo "default")
EXTRACT_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/gemini-cli-fork.${HASH}"

if [[ ! -f "${EXTRACT_DIR}/.expanded" ]]; then
  rm -rf "${EXTRACT_DIR}"
  mkdir -p "${EXTRACT_DIR}"
  (
    exec < "${SELF}"
    while read line && [[ "${line}" != "# END_STUB" ]]; do :; done
    exec tar xzf - -m -C "${EXTRACT_DIR}"
  )
  touch "${EXTRACT_DIR}/.expanded"
fi

exec "${EXTRACT_DIR}/run.sh" "$@"
# END_STUB
STUB_EOF

(cd "${STAGING_DIR}" && tar czf - .) >> "${OUTPUT}"
chmod +x "${OUTPUT}"

rm -rf "${STAGING_DIR}"

SIZE=$(du -h "${OUTPUT}" | cut -f1)
echo ""
echo "=== Done ==="
echo "Binary: ${OUTPUT} (${SIZE})"
echo ""
echo "Usage:"
echo "  ${OUTPUT}"
echo "  cp ${OUTPUT} ~/bin/gemini-dev && gemini-dev"
