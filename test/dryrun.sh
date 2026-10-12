#!/usr/bin/env bash
# dryrun.sh — walk the claim endpoint: the 402 that names the price, a malformed
# payment, a plain-transfer proof, and (with a facilitator key deployed) the
# refusal of a payload that is not signed by anyone. Against a local
# (`npm run dev`, http://127.0.0.1:8787) or deployed instance.
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

echo "== 1. GET /claim -> 402 Payment Required (expect HTTP/1.1 402)"
curl -sS -i "$BASE_URL/claim" | sed -n '1,12p'; echo

echo "== 2. decode the PAYMENT-REQUIRED header (base64 -> PaymentRequired JSON: accepts[], extensions.bazaar)"
curl -sS -D - -o /dev/null "$BASE_URL/claim" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | decode_b64 | python3 -m json.tool 2>/dev/null || echo "(header decode skipped)"
echo

echo "== 3. HEAD /claim -> the same 402 headers, no body"
curl -sS -I "$BASE_URL/claim" | sed -n '1,6p'; echo

echo "== 4. a malformed payment header -> 400"
curl -sS -i "$BASE_URL/claim" -H "X-PAYMENT: not-a-proof" | sed -n '1,12p'; echo

echo "== 5. an unsigned x402 payload -> 503 (no facilitator key) or 402 (the facilitator refuses it)"
PAYLOAD=$(printf '{"x402Version":2,"accepted":{"scheme":"exact","network":"eip155:8453","amount":"1000000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23","maxTimeoutSeconds":600},"payload":{"signature":"0x%s","authorization":{"from":"0x%s","to":"0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23","value":"1000000","validAfter":"0","validBefore":"%s","nonce":"0x%s"}}}' \
  "$(printf 'ab%.0s' $(seq 65))" "$(printf '11%.0s' $(seq 20))" "$(( $(date +%s) + 600 ))" "$(printf 'cd%.0s' $(seq 32))" | base64 | tr -d '\n')
curl -sS -i "$BASE_URL/claim" -H "PAYMENT-SIGNATURE: $PAYLOAD" | sed -n '1,14p'; echo

echo "== 6. a tx-hash proof (X-PAYMENT header)"
if [ -n "${TX_HASH:-}" ]; then
  PROOF=$(printf '{"x402Version":2,"payload":{"txHash":"%s"}}' "$TX_HASH" | base64 | tr -d '\n')
  echo "-- real proof for $TX_HASH:"
  curl -sS -i "$BASE_URL/claim" -X POST -H "X-PAYMENT: $PROOF"; echo
else
  PROOF=$(printf '{"x402Version":2,"payload":{"txHash":"0x%s"}}' "$(printf '0%.0s' $(seq 64))" | base64 | tr -d '\n')
  echo "-- bogus (all-zero) tx hash: expect verified:false from the RPC check:"
  curl -sS -i "$BASE_URL/claim" -X POST -H "X-PAYMENT: $PROOF"; echo
  echo "-- tip: rerun with TX_HASH=0x… to see a real verified receipt."
fi
echo

echo "== 7. same verification logic against live Base mainnet (node, read-only)"
node ./verify_transfer.js ${TX_HASH:+"$TX_HASH"}

echo
echo "== 8. GET / -> 302 to thefirstwall.ai"
curl -sS -i "$BASE_URL/" | sed -n '1,4p'
