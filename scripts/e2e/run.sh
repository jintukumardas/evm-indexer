#!/usr/bin/env bash
#
# End-to-end validation against the live Polygon network.
#
# What it does:
#   1. Resolves the live Polygon head via JSON-RPC
#   2. Spins up a throwaway MongoDB container (mapped to host port 27018 by
#      default so it can't collide with a developer's local mongo)
#   3. Runs the indexer one-pass over a small recent window
#   4. Starts the API on host port 3001
#   5. Runs src/scripts/e2eValidate.ts which asserts:
#        - SyncState advanced past the safe head
#        - persisted events have the expected shape (lowercased addrs,
#          decimal-string fees, blockNumber inside the window)
#        - GET /health returns ok
#        - GET /metrics exposes indexer_last_synced_block + http_requests_total
#        - GET /fee-events returns the sample integrator's events
#        - GET /fee-events/aggregates returns rolled-up sums (if events present)
#        - GET /openapi.json returns the 3.0.3 spec
#
# Required: docker, node >=20, npm install already run.
# Optional env: POLYGON_RPC_URL, POLYGON_RPC_URLS, E2E_BLOCK_WINDOW,
#               MONGO_HOST_PORT, API_PORT, E2E_KEEP_MONGO=1 (skip teardown).
#
# Exit code: 0 on full success, 1 otherwise. All cleanup happens via traps.

set -euo pipefail

cd "$(dirname "$0")/../.."

# ----- Config (with safe defaults) -----------------------------------------
# Public RPCs we'll try in order if the user didn't set POLYGON_RPC_URL.
# This list is intentionally curated to endpoints that, at the time of writing,
# accept anonymous traffic. Override with POLYGON_RPC_URL=… for a paid endpoint.
PUBLIC_POLYGON_RPCS=(
  "https://polygon-bor-rpc.publicnode.com"
  "https://polygon.llamarpc.com"
  "https://polygon.drpc.org"
  "https://polygon-mainnet.public.blastapi.io"
  "https://1rpc.io/matic"
  "https://rpc.ankr.com/polygon"
)
: "${POLYGON_RPC_URL:=}"
: "${POLYGON_RPC_URLS:=}"
: "${POLYGON_FEE_COLLECTOR_ADDRESS:=0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9}"
: "${POLYGON_CHUNK_SIZE:=1000}"
: "${POLYGON_MIN_CHUNK_SIZE:=50}"
: "${POLYGON_CONFIRMATIONS:=12}"
: "${POLYGON_MAX_CHUNK_RETRIES:=6}"
# FeesCollected fires intermittently. The harness first probes recent history
# in 9500-block chunks across each candidate RPC. If that turns up nothing,
# it falls back to a historical anchor block where we know events exist.
#
# Set E2E_USE_ANCHOR=1 to SKIP the recent probe and go straight to the
# anchor — useful when you want a deterministic run against known data
# (e.g. CI, or when public RPCs are flaking on recent blocks).
: "${E2E_BLOCK_WINDOW:=10000}"
: "${E2E_USE_ANCHOR:=}"
: "${E2E_ANCHOR_BLOCK:=85789000}"
: "${E2E_ANCHOR_RADIUS:=400}"
: "${MONGO_HOST_PORT:=27018}"      # don't collide with local 27017
: "${API_PORT:=3001}"
: "${MONGO_DB_NAME:=lifi_e2e}"
: "${CONTAINER_NAME:=lifi-e2e-mongo}"
: "${API_LOG_FILE:=/tmp/lifi-e2e-api.log}"
: "${WORKER_LOG_FILE:=/tmp/lifi-e2e-worker.log}"
: "${E2E_KEEP_MONGO:=}"

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "  \033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ----- Prereq checks --------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker not on PATH"
command -v node   >/dev/null 2>&1 || die "node not on PATH"
[ -d node_modules ] || die "node_modules missing — run 'npm install' first"

# ----- Cleanup trap (always runs) ------------------------------------------
API_PID=""
cleanup() {
  local code=$?
  step "Cleanup"
  if [ -n "${API_PID}" ] && kill -0 "${API_PID}" 2>/dev/null; then
    kill "${API_PID}" 2>/dev/null || true
    wait "${API_PID}" 2>/dev/null || true
    ok "API process stopped"
  fi
  if [ -z "${E2E_KEEP_MONGO}" ]; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 && ok "Mongo container removed" || true
  else
    warn "E2E_KEEP_MONGO set — leaving '${CONTAINER_NAME}' running on port ${MONGO_HOST_PORT}"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ----- 1. Resolve live Polygon head ----------------------------------------
# Builds the candidate list: user-supplied URL(s) first, then public fallbacks.
# We probe each with eth_blockNumber and pick the first that returns a real
# result. Whichever URL wins is used for the rest of the run; failing
# endpoints are skipped (their errors logged, not fatal).
step "Resolving Polygon head"

declare -a RPC_CANDIDATES=()
if [ -n "${POLYGON_RPC_URLS}" ]; then
  IFS=',' read -ra _csv <<< "${POLYGON_RPC_URLS}"
  for u in "${_csv[@]}"; do RPC_CANDIDATES+=("$(echo "$u" | xargs)"); done
fi
if [ -n "${POLYGON_RPC_URL}" ]; then
  RPC_CANDIDATES+=("${POLYGON_RPC_URL}")
fi
# Append public fallbacks (de-duplicating by URL).
for u in "${PUBLIC_POLYGON_RPCS[@]}"; do
  skip=0
  for existing in "${RPC_CANDIDATES[@]:-}"; do [ "$existing" = "$u" ] && skip=1; done
  [ "$skip" -eq 0 ] && RPC_CANDIDATES+=("$u")
done

probe_rpc() {
  node -e '
    const url = process.argv[1];
    const body = JSON.stringify({jsonrpc:"2.0",method:"eth_blockNumber",params:[],id:1});
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body, signal: ac.signal})
      .then(r => r.json())
      .then(j => {
        clearTimeout(t);
        if (j && typeof j.result === "string") { console.log(parseInt(j.result, 16)); process.exit(0); }
        console.error(JSON.stringify(j.error || j).slice(0, 240));
        process.exit(2);
      })
      .catch(e => { console.error(e.message); process.exit(3); });
  ' "$1"
}

LATEST=""
WORKING_RPC=""
for url in "${RPC_CANDIDATES[@]}"; do
  printf "  trying %-55s ... " "$url"
  if out=$(probe_rpc "$url" 2>&1); then
    LATEST="$out"
    WORKING_RPC="$url"
    echo "ok (block=${LATEST})"
    break
  else
    echo "fail (${out})"
  fi
done

if [ -z "${LATEST}" ] || [ -z "${WORKING_RPC}" ]; then
  die "No usable Polygon RPC found. Set POLYGON_RPC_URL to a working endpoint and retry."
fi
POLYGON_RPC_URL="${WORKING_RPC}"
ok "Using RPC: ${POLYGON_RPC_URL} (latest=${LATEST})"

SAFE_HEAD=$(( LATEST - POLYGON_CONFIRMATIONS ))
ok "Safe head = ${SAFE_HEAD} (latest - ${POLYGON_CONFIRMATIONS} confirmations)"

# ----- 1b. Find a window that actually contains FeesCollected events -------
# Why: the contract's "Transactions" tab on Polygonscan is mostly Batch
# Withdraws, which do NOT emit FeesCollected. Real FeesCollected emissions
# come from user-initiated bridge/swap txns and arrive sporadically. Probing
# directly via eth_getLogs is far more reliable than guessing a window size.
#
# We probe each candidate RPC × expanding window. The first (rpc, range)
# pair that returns at least one event wins. Pruned RPCs raise -32701 here
# and we move on to the next candidate. If nothing returns events, we fall
# back to a default window and the validator skips event-dependent assertions.

# topic0 = keccak256("FeesCollected(address,address,uint256,uint256)")
TOPIC0=$(node -e '
  const { ethers } = require("ethers");
  const iface = new ethers.utils.Interface([
    "event FeesCollected(address indexed _token, address indexed _integrator, uint256 _integratorFee, uint256 _lifiFee)"
  ]);
  console.log(iface.getEventTopic("FeesCollected"));
')
echo "  FeesCollected topic0 = ${TOPIC0}"

probe_logs() {
  # Args: url, from, to, topic0, address. stdout: "EMPTY" | "FOUND <min> <max> <count>"
  # NB: with `node -e SCRIPT a b c`, process.argv = [node, a, b, c] — no entry
  # for the script string. Skip exactly one (the node binary path).
  node -e '
    const [, url, fromS, toS, topic0, addr] = process.argv;
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getLogs",
      params: [{
        fromBlock: "0x" + Number(fromS).toString(16),
        toBlock:   "0x" + Number(toS).toString(16),
        address:   addr,
        topics:    [topic0],
      }],
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body, signal: ac.signal})
      .then((r) => r.json())
      .then((j) => {
        clearTimeout(timer);
        if (j.error) { console.error("RPC_ERROR:" + (j.error.message || JSON.stringify(j.error)).slice(0,180)); process.exit(2); }
        if (!Array.isArray(j.result)) { console.error("BAD_SHAPE"); process.exit(3); }
        if (j.result.length === 0) { console.log("EMPTY"); process.exit(0); }
        const blocks = j.result.map((l) => parseInt(l.blockNumber, 16));
        console.log(`FOUND ${Math.min(...blocks)} ${Math.max(...blocks)} ${j.result.length}`);
      })
      .catch((e) => { console.error("CRASH:" + e.message.slice(0,180)); process.exit(4); });
  ' "$1" "$2" "$3" "$4" "$5"
}

EVENT_MIN_BLOCK=""
EVENT_MAX_BLOCK=""
EVENT_COUNT_PROBE=""
: "${PROBE_CHUNK_SIZE:=9500}"     # under the typical 10k cap
: "${PROBE_MAX_CHUNKS:=20}"       # ≈ 190k blocks back (~5 days on Polygon)

if [ -n "${E2E_USE_ANCHOR}" ]; then
  step "E2E_USE_ANCHOR=1 — skipping recent-history probe, going straight to anchor"
else

step "Searching candidate RPCs for recent FeesCollected events"
# Most public RPCs cap eth_getLogs at 10 000 blocks per call, so we walk
# backwards in fixed-size chunks rather than asking for one large range.
# Total search depth = PROBE_CHUNK_SIZE * PROBE_MAX_CHUNKS.

for url in "${RPC_CANDIDATES[@]}"; do
  printf "  trying %-50s\n" "$url"
  rpc_failed=false
  to=${SAFE_HEAD}
  for (( chunk=1; chunk<=PROBE_MAX_CHUNKS; chunk++ )); do
    from=$(( to - PROBE_CHUNK_SIZE + 1 ))
    [ "${from}" -lt 0 ] && from=0
    printf "    chunk %2d: blocks %d..%d  " "$chunk" "$from" "$to"
    set +e
    out=$(probe_logs "$url" "$from" "$to" "$TOPIC0" "$POLYGON_FEE_COLLECTOR_ADDRESS" 2>&1)
    rc=$?
    set -e
    if [ "${rc}" -ne 0 ]; then
      echo "skip (${out})"
      rpc_failed=true
      break # error on this RPC — try the next one
    fi
    if [[ "${out}" =~ ^FOUND ]]; then
      EVENT_MIN_BLOCK=$(echo "${out}" | awk '{print $2}')
      EVENT_MAX_BLOCK=$(echo "${out}" | awk '{print $3}')
      EVENT_COUNT_PROBE=$(echo "${out}" | awk '{print $4}')
      echo "found ${EVENT_COUNT_PROBE} event(s), blocks ${EVENT_MIN_BLOCK}..${EVENT_MAX_BLOCK}"
      POLYGON_RPC_URL="$url"
      break 2
    fi
    echo "empty"
    [ "${from}" -le 0 ] && break
    to=$(( from - 1 ))
  done
  if [ "${rpc_failed}" = false ]; then
    printf "    (no events in last %d blocks on %s)\n" "$(( PROBE_CHUNK_SIZE * PROBE_MAX_CHUNKS ))" "$url"
  fi
done

fi  # end if [ -n "${E2E_USE_ANCHOR}" ]

if [ -n "${EVENT_MIN_BLOCK}" ]; then
  # Tight window around the probed events with a small buffer either side.
  BUFFER=250
  START_BLOCK=$(( EVENT_MIN_BLOCK - BUFFER ))
  [ "${START_BLOCK}" -lt 0 ] && START_BLOCK=0
  TARGET_TO=$(( EVENT_MAX_BLOCK + BUFFER ))
  [ "${TARGET_TO}" -gt "${SAFE_HEAD}" ] && TARGET_TO="${SAFE_HEAD}"
  EFFECTIVE_CONFIRMATIONS=$(( LATEST - TARGET_TO ))
  [ "${EFFECTIVE_CONFIRMATIONS}" -lt 0 ] && EFFECTIVE_CONFIRMATIONS=0
  ok "Selected RPC: ${POLYGON_RPC_URL}"
  ok "Scan window: ${START_BLOCK} → ${TARGET_TO} ($(( TARGET_TO - START_BLOCK )) blocks, ${EVENT_COUNT_PROBE} known event(s))"
else
  # Either: recent probe came back empty, OR the operator forced anchor mode
  # via E2E_USE_ANCHOR=1. Use a historical block where FeesCollected has
  # been confirmed to exist. Override via E2E_ANCHOR_BLOCK.
  if [ -n "${E2E_USE_ANCHOR}" ]; then
    step "Selecting anchor block ${E2E_ANCHOR_BLOCK} (±${E2E_ANCHOR_RADIUS})"
  else
    warn "No FeesCollected events in recent history on any RPC"
    warn "Falling back to historical anchor block ${E2E_ANCHOR_BLOCK} (±${E2E_ANCHOR_RADIUS})"
    warn "Override with E2E_ANCHOR_BLOCK=<block> if the default is pruned by your RPC"
  fi

  # Pick the first RPC that can actually serve the anchor depth AND returns
  # events there — some RPCs prune older history (publicnode), some allow
  # the depth but with smaller chunk caps (1rpc, drpc).
  anchor_from=$(( E2E_ANCHOR_BLOCK - E2E_ANCHOR_RADIUS ))
  anchor_to=$(( E2E_ANCHOR_BLOCK + E2E_ANCHOR_RADIUS ))
  [ "${anchor_from}" -lt 0 ] && anchor_from=0
  picked_rpc=""
  for url in "${RPC_CANDIDATES[@]}"; do
    printf "    anchor probe %-50s ... " "$url"
    set +e
    out=$(probe_logs "$url" "$anchor_from" "$anchor_to" "$TOPIC0" "$POLYGON_FEE_COLLECTOR_ADDRESS" 2>&1)
    rc=$?
    set -e
    if [ "${rc}" -ne 0 ]; then
      echo "skip (${out})"
      continue
    fi
    if [[ "${out}" =~ ^FOUND ]]; then
      EVENT_COUNT_PROBE=$(echo "${out}" | awk '{print $4}')
      echo "ok — ${EVENT_COUNT_PROBE} event(s) at anchor"
      picked_rpc="$url"
      break
    fi
    echo "empty (RPC reachable but no events at anchor)"
    [ -z "${picked_rpc}" ] && picked_rpc="$url"   # remember as fallback
  done

  if [ -z "${picked_rpc}" ]; then
    die "No RPC can serve the anchor depth. Set E2E_ANCHOR_BLOCK to a newer block, or POLYGON_RPC_URL to an archive endpoint."
  fi
  POLYGON_RPC_URL="${picked_rpc}"

  START_BLOCK="${anchor_from}"
  TARGET_TO="${anchor_to}"
  EFFECTIVE_CONFIRMATIONS=$(( LATEST - TARGET_TO ))
  [ "${EFFECTIVE_CONFIRMATIONS}" -lt 0 ] && EFFECTIVE_CONFIRMATIONS=0
  # Tighten chunk size — free-tier RPCs cap eth_getLogs to 500 blocks at
  # this depth on Polygon. The indexer's adaptive shrink would land here
  # anyway, but starting low saves a round trip.
  POLYGON_CHUNK_SIZE=400
  POLYGON_MIN_CHUNK_SIZE=50
  ok "Selected RPC: ${POLYGON_RPC_URL}"
  ok "Anchor window: ${START_BLOCK} → ${TARGET_TO} ($(( TARGET_TO - START_BLOCK )) blocks)"
fi

# ----- 2. Spin up Mongo ----------------------------------------------------
step "Starting throwaway MongoDB"
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER_NAME}" \
  -p "${MONGO_HOST_PORT}:27017" \
  --health-cmd 'mongosh --quiet --eval "db.adminCommand({ping:1}).ok" || exit 1' \
  --health-interval 2s --health-retries 30 --health-timeout 3s \
  mongo:7 >/dev/null
ok "Container ${CONTAINER_NAME} started on host port ${MONGO_HOST_PORT}"

step "Waiting for Mongo to accept connections"
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "starting")
  if [ "${status}" = "healthy" ]; then
    ok "Mongo healthy"
    break
  fi
  sleep 1
done
[ "${status}" = "healthy" ] || die "Mongo did not become healthy in time"

MONGO_URI="mongodb://localhost:${MONGO_HOST_PORT}/${MONGO_DB_NAME}"

# ----- 3. Run the indexer once over the probed window ----------------------
step "Running indexer against ${POLYGON_RPC_URL}"
echo "    range:    ${START_BLOCK} → ${TARGET_TO} ($(( TARGET_TO - START_BLOCK )) blocks)"
echo "    chunk:    ${POLYGON_CHUNK_SIZE} (min ${POLYGON_MIN_CHUNK_SIZE})"
echo "    confirms: ${EFFECTIVE_CONFIRMATIONS} (effective; pins safe head to ${TARGET_TO})"
echo "    log:      ${WORKER_LOG_FILE}"

set +e
MONGO_URI="${MONGO_URI}" \
POLYGON_RPC_URL="${POLYGON_RPC_URL}" \
POLYGON_RPC_URLS="${POLYGON_RPC_URLS}" \
POLYGON_FEE_COLLECTOR_ADDRESS="${POLYGON_FEE_COLLECTOR_ADDRESS}" \
POLYGON_START_BLOCK="${START_BLOCK}" \
POLYGON_CONFIRMATIONS="${EFFECTIVE_CONFIRMATIONS}" \
POLYGON_CHUNK_SIZE="${POLYGON_CHUNK_SIZE}" \
POLYGON_MIN_CHUNK_SIZE="${POLYGON_MIN_CHUNK_SIZE}" \
POLYGON_MAX_CHUNK_RETRIES="${POLYGON_MAX_CHUNK_RETRIES}" \
SYNC_RUN_ONCE=true \
LOG_LEVEL="${LOG_LEVEL:-info}" \
TOKEN_ENRICHMENT_ENABLED=false \
AGGREGATES_ENABLED=true \
API_ENABLED=false \
NODE_ENV=development \
npx --no-install tsx src/jobs/syncIndexer.ts > "${WORKER_LOG_FILE}" 2>&1
sync_rc=$?
set -e

if [ "${sync_rc}" -ne 0 ]; then
  echo "----- last 40 lines of ${WORKER_LOG_FILE} -----"
  tail -n 40 "${WORKER_LOG_FILE}" || true
  die "indexer worker exited ${sync_rc}"
fi

EVENT_COUNT=$(docker exec "${CONTAINER_NAME}" mongosh --quiet "${MONGO_DB_NAME}" \
  --eval 'print(db.fee_events.countDocuments({}))' | tail -n 1 | tr -d '\r')
if ! [[ "${EVENT_COUNT}" =~ ^[0-9]+$ ]]; then EVENT_COUNT=0; fi
ok "Sync complete — ${EVENT_COUNT} FeesCollected event(s) persisted"

# ----- 4. Start the API ----------------------------------------------------
step "Starting API on port ${API_PORT}"
MONGO_URI="${MONGO_URI}" \
POLYGON_RPC_URL="${POLYGON_RPC_URL}" \
POLYGON_FEE_COLLECTOR_ADDRESS="${POLYGON_FEE_COLLECTOR_ADDRESS}" \
POLYGON_START_BLOCK="${START_BLOCK}" \
API_PORT="${API_PORT}" \
API_ENABLED=true \
LOG_LEVEL="${LOG_LEVEL:-info}" \
NODE_ENV=development \
npx --no-install tsx src/index.ts > "${API_LOG_FILE}" 2>&1 &
API_PID=$!
ok "API spawned (pid ${API_PID})"

step "Waiting for API to be ready"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
    ok "API responding"
    break
  fi
  if ! kill -0 "${API_PID}" 2>/dev/null; then
    echo "----- last 40 lines of ${API_LOG_FILE} -----"
    tail -n 40 "${API_LOG_FILE}" || true
    die "API process exited before /health came up"
  fi
  sleep 1
done

# ----- 5. Validator --------------------------------------------------------
step "Running validator"
MONGO_URI="${MONGO_URI}" \
API_BASE="http://localhost:${API_PORT}" \
EXPECTED_FROM_BLOCK="${START_BLOCK}" \
EXPECTED_TO_BLOCK="${TARGET_TO}" \
POLYGON_FEE_COLLECTOR_ADDRESS="${POLYGON_FEE_COLLECTOR_ADDRESS}" \
npx --no-install tsx src/scripts/e2eValidate.ts

step "🎉 End-to-end validation passed"
