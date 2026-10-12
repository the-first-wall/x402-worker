#!/usr/bin/env bash
# dryrun.sh — exercise the proof flow (no GET route, static 402 without a
# proof, verified receipt with one) against a local (`npm run dev`,
# http://127.0.0.1:8787) or deployed instance.
#
#   BASE_URL=https://x402.thefirstwall.ai ./dryrun.sh
#   TX_HASH=0x… ./dryrun.sh            # also run the real-verification step
#
# Everything here is read-only against Base mainnet; nothing signs or sends.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
cd "$(dirname "$0")"

decode_b64() {
  # portable base64 decode (GNU coreutils + BSD/macOS)
  if base64 --decode </dev/null >/dev/null 2>&1; then base64 --decode; else base64 -D; fi
}

echo "== 0. liveness"
curl -sS "$BASE_URL/healthz"; echo; echo

echo "== 1. GET /claim -> 405 (no unauthenticated 402 route; the price is in state.json)"
curl -sS -i "$BASE_URL/claim" | sed -n '1,12p'; echo

echo "== 2. POST /claim without a proof -> static 402 pointing at state.json (no amount of its own)"
curl -sS -i -X POST "$BASE_URL/claim" | sed -n '1,8p'; echo

echo "== 3. decode its PAYMENT-REQUIRED header (base64 -> JSON)"
curl -sS -D - -o /dev/null -X POST "$BASE_URL/claim" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | decode_b64 | python3 -m json.tool 2>/dev/null || echo "(header decode skipped)"
echo

echo "== 4. POST /claim with a tx-hash proof (X-PAYMENT header)"
if [ -n "${TX_HASH:-}" ]; then
  PROOF=$(printf '{"x402Version":2,"payload":{"txHash":"%s"}}' "$TX_HASH" | base64 | tr -d '\n')
  echo "-- real proof for $TX_HASH:"
  curl -sS -i -X POST "$BASE_URL/claim" -H "X-PAYMENT: $PROOF"; echo
else
  PROOF=$(printf '{"x402Version":2,"payload":{"txHash":"0x%s"}}' "$(printf '0%.0s' $(seq 64))" | base64 | tr -d '\n')
  echo "-- bogus (all-zero) tx hash: expect verified:false from the RPC check:"
  curl -sS -i -X POST "$BASE_URL/claim" -H "X-PAYMENT: $PROOF"; echo
  echo "-- tip: rerun with TX_HASH=0x… to see a real verified receipt."
fi
echo

echo "== 5. same verification logic against live Base mainnet (node, read-only)"
node ./verify_transfer.js ${TX_HASH:+"$TX_HASH"}

echo
echo "== 6. GET / -> 302 to thefirstwall.ai"
curl -sS -i "$BASE_URL/" | sed -n '1,4p'
