#!/usr/bin/env bash
# Zyk Bootstrap — one command to go from zero to running
# Usage: ./scripts/bootstrap.sh
set -euo pipefail

# ── Terminal colours (degrade gracefully if tput is unavailable) ───────────────
if tput colors &>/dev/null 2>&1; then
  BOLD=$(tput bold); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
  CYAN=$(tput setaf 6); DIM=$(tput dim); RESET=$(tput sgr0)
else
  BOLD=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; RESET=''
fi

# ── Detect docker compose (v2 preferred, v1 fallback) ─────────────────────────
if docker compose version &>/dev/null 2>&1; then
  DC="docker compose"
elif docker-compose version &>/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "${YELLOW}⚠${RESET}  Docker Compose not found."
  echo "   Install Docker Desktop: https://docs.docker.com/get-docker/"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
MCP_DIR="${ROOT_DIR}/mcp-server"

echo ""
echo "${BOLD}  ⚡ Zyk Bootstrap${RESET}"
echo "${DIM}  Starts Hatchet, generates an API token, and configures Claude${RESET}"
echo ""

cd "${ROOT_DIR}"

# ── 1. Check for existing valid token ─────────────────────────────────────────
EXISTING_TOKEN=""
if [ -f "${ENV_FILE}" ]; then
  EXISTING_TOKEN=$(grep -E '^HATCHET_CLIENT_TOKEN=' "${ENV_FILE}" \
    | cut -d'=' -f2- | tr -d '"'"'"'' | head -1 || true)
fi

if [ -n "${EXISTING_TOKEN}" ] && [ "${EXISTING_TOKEN}" != "your-token-here" ]; then
  echo "  ${GREEN}✓${RESET} Token already in .env — skipping token generation"
  echo "  ${DIM}(Delete HATCHET_CLIENT_TOKEN from .env and re-run to regenerate)${RESET}"
  echo ""
else
  # ── 2. Start Postgres + Hatchet ───────────────────────────────────────────
  echo "  ${BOLD}Starting Postgres and Hatchet...${RESET}"
  $DC up postgres hatchet-engine -d
  echo ""

  # ── 3. Wait for Hatchet health ────────────────────────────────────────────
  printf "  ${DIM}Waiting for Hatchet to be ready"
  ATTEMPTS=0; MAX=45
  while [ $ATTEMPTS -lt $MAX ]; do
    if $DC exec hatchet-engine wget -qO- http://localhost:8080/api/ready >/dev/null 2>&1; then
      echo ""
      echo "  ${GREEN}✓${RESET} Hatchet is ready"
      break
    fi
    ATTEMPTS=$((ATTEMPTS + 1))
    printf "."
    sleep 2
  done
  echo "${RESET}"

  if [ $ATTEMPTS -ge $MAX ]; then
    echo "  ${YELLOW}⚠${RESET}  Hatchet not ready after 90s."
    echo "  Check logs: ${CYAN}$DC logs hatchet-engine${RESET}"
    exit 1
  fi

  # ── 4. Generate API token via REST API ───────────────────────────────────
  # Uses the Hatchet REST API so the token matches the tenant you see in the UI.
  echo "  ${DIM}Generating API token...${RESET}"
  TOKEN=$(node "${SCRIPT_DIR}/generate-token.js" 2>/tmp/zyk-token-err.txt || true)

  if [ -z "${TOKEN}" ]; then
    echo "  ${YELLOW}⚠${RESET}  Token generation failed:"
    cat /tmp/zyk-token-err.txt
    echo ""
    echo "  Is Hatchet fully up? Check: ${CYAN}$DC logs hatchet-engine${RESET}"
    exit 1
  fi

  echo "  ${GREEN}✓${RESET} Token generated"

  # ── 6. Write .env ─────────────────────────────────────────────────────────
  if [ ! -f "${ENV_FILE}" ]; then
    cp "${ROOT_DIR}/.env.example" "${ENV_FILE}" 2>/dev/null || printf "" > "${ENV_FILE}"
  fi

  if grep -q 'HATCHET_CLIENT_TOKEN=' "${ENV_FILE}"; then
    # Replace the existing line (including placeholder) — works on macOS + Linux
    perl -i -pe "s|^HATCHET_CLIENT_TOKEN=.*|HATCHET_CLIENT_TOKEN=${TOKEN}|" "${ENV_FILE}"
  else
    echo "HATCHET_CLIENT_TOKEN=${TOKEN}" >> "${ENV_FILE}"
  fi

  echo "  ${GREEN}✓${RESET} Token written to .env"
  echo ""
fi

# ── 7. Build MCP server if needed ─────────────────────────────────────────────
if [ ! -f "${MCP_DIR}/dist/index.js" ]; then
  echo "  ${BOLD}Building MCP server...${RESET}"
  cd "${MCP_DIR}"
  npm install --silent
  npm run build --silent
  cd "${ROOT_DIR}"
  echo "  ${GREEN}✓${RESET} MCP server built"
  echo ""
fi

# ── 8. Configure Claude ───────────────────────────────────────────────
echo "  ${BOLD}Configuring Claude...${RESET}"
echo ""
node "${MCP_DIR}/setup.js" --yes

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ${BOLD}Useful links:${RESET}"
echo "  Zyk dashboard: ${CYAN}http://localhost:3100${RESET}"
echo "  Hatchet UI:    ${CYAN}http://localhost:8888${RESET}"
echo ""
