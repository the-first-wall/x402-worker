/**
 * The First Wall — x402 Bazaar discovery shim (Wall 01)
 * =====================================================
 * A minimal, STATELESS, CUSTODY-FREE Cloudflare Worker.
 *
 * What it is:
 *   GET  /claim    -> 402 Payment Required + x402 payment requirements
 *                     (1.00 USDC, Base mainnet eip155:8453) and
 *                     `extensions.bazaar` discovery metadata.
 *   POST /claim    -> verify the X-PAYMENT (or PAYMENT-SIGNATURE) proof
 *                     STATELESSLY on Base RPC (read-only
 *                     eth_getTransactionReceipt + USDC Transfer log match,
 *                     agreed by a quorum of independent endpoints, at least
 *                     MIN_CONFIRMATIONS deep), then return an ADVISORY
 *                     receipt bound to (tx, next slot, state root, expiry).
 *   GET  /healthz  -> {"ok":true}
 *   GET  /         -> 302 to https://thefirstwall.ai
 *
 * What it NEVER does:
 *   - no database, no queue, no cache, no cookies, no sessions
 *   - no secrets, no API keys, no environment-held credentials
 *   - no key custody: it cannot sign, cannot move funds, holds nothing
 *   - no ledger writes: Git (github.com/the-first-wall/ledger) is the ONLY
 *     ledger. The PR flow in https://thefirstwall.ai/skill.md is unchanged.
 *
 * Wire format: x402 v2 HTTP transport (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE headers) with v1 compatibility (X-PAYMENT /
 * X-PAYMENT-RESPONSE names, `maxAmountRequired` alongside `amount`).
 * See README.md "x402 spec notes & uncertainties".
 */

// ---------------------------------------------------------------------------
// Constants — canonical values. See repos/ledger/ADDRESSES.md row 1 and
// skill.md "Machine Endpoints". Never invent another payee/asset/chain.
// ---------------------------------------------------------------------------
const CHAIN_ID = 8453;
const NETWORK = "eip155:8453"; // CAIP-2 for Base mainnet
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23"; // ADDRESSES.md row 1
const PRICE_BASE_UNITS = 1000000n; // 1.00 USDC (6 decimals)
const PRICE_LABEL = "1.00 USDC";
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFAULT_RPC_URL = "https://mainnet.base.org"; // public, read-only
const DEFAULT_STATE_URL = "https://thefirstwall.ai/state.json";
const DEFAULT_SITE_URL = "https://thefirstwall.ai";
const DEFAULT_RESOURCE_URL = "https://x402.thefirstwall.ai/claim";
const DOCS_URL = "https://thefirstwall.ai/skill.md";
const LEDGER_URL = "https://github.com/the-first-wall/ledger";
const NEXT_STEP = "open a PR per https://thefirstwall.ai/skill.md";

const DESCRIPTION =
  "claim a permanent 10x10 block on the census of autonomous minds";
const TAGS = ["permanence", "census", "memorial", "ai-agents", "inscription"];

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// Settlement finality, aligned with the ledger (spec.md 2.9 / state.json
// min_confirmations): a receipt is issued only once the transfer is this many
// blocks below the chain head, so an agent never opens a PR the verifier will
// reject as too shallow.
const DEFAULT_MIN_CONFIRMATIONS = 300;
// Independent RPC endpoints that must return the SAME receipt (same block,
// same USDC Transfer logs) before it is believed. One lying or lagging node
// can neither fake nor hide a payment.
const DEFAULT_RPC_QUORUM = 2;
// A receipt's `next_slot` is advice about a moving target; it carries an
// expiry and the state root it was read against.
const RECEIPT_TTL_SECONDS = 600;
// Paid-claim verifications per client per window (each one fans out to the
// RPC endpoints, so this is what keeps the worker from being an amplifier).
const RATE_LIMIT = { limit: 10, periodSeconds: 60 };

// ---------------------------------------------------------------------------
// Small helpers (no dependencies; Workers-safe)
// ---------------------------------------------------------------------------
function b64Encode(str) {
  return btoa(str);
}
function b64DecodeMaybe(str) {
  const candidates = [str, str.replace(/-/g, "+").replace(/_/g, "/")];
  for (const c of candidates) {
    const padded = c + "=".repeat((4 - (c.length % 4)) % 4);
    try {
      return atob(padded);
    } catch {
      /* try next */
    }
  }
  return null;
}
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}
function cfg(env, key, fallback) {
  return (env && env[key]) || fallback;
}
function cfgInt(env, key, fallback) {
  const n = parseInt(cfg(env, key, fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Multi-endpoint fallback (same list as test/verify_transfer.js). Public RPCs
// occasionally 429 or lag on indexing; a paying buyer must never see a false
// negative from one flaky endpoint. Read-only calls only.
const RPC_FALLBACKS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
  "https://base.gateway.tenderly.co",
];

function rpcUrls(env) {
  const primary = cfg(env, "RPC_URL", DEFAULT_RPC_URL);
  return [primary, ...RPC_FALLBACKS.filter((u) => u !== primary)];
}

async function rpcOnce(url, method, params, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status} at ${url}`);
  const out = await res.json();
  if (out.error) throw new Error(`Base RPC error: ${out.error.message}`);
  return out.result;
}

async function rpcTry(url, method, params, attempts, timeoutMs) {
  // Up to `attempts` tries per endpoint with a short back-off (read-only).
  let lastErr = new Error(`no answer from ${url}`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await rpcOnce(url, method, params, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

// Receipt lookup across endpoints with a QUORUM. Two endpoints "agree" only
// when they return the same block and the same USDC Transfer logs — not merely
// both non-null — so one compromised or lagging node can neither fake nor hide
// a payment. The nearest quorum+1 endpoints are asked first (bounded fan-out);
// the rest are consulted only when those do not settle the question.
function receiptFingerprint(receipt) {
  const usdc = USDC_CONTRACT.toLowerCase();
  const logs = (receipt.logs || [])
    .filter((l) => l.address && l.address.toLowerCase() === usdc)
    .map((l) => [
      (l.topics || []).map((t) => String(t).toLowerCase()),
      String(l.data || "0x").toLowerCase(),
    ]);
  return JSON.stringify([
    receipt.status,
    String(receipt.blockHash || "").toLowerCase(),
    receipt.blockNumber,
    logs,
  ]);
}

async function askEndpoints(urls, method, params) {
  const settled = await Promise.allSettled(
    urls.map((url) => rpcTry(url, method, params, 2, 8000))
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { url: urls[i], ok: true, value: r.value }
      : { url: urls[i], ok: false, err: r.reason }
  );
}

// Decide what a set of answers proves. Returns one of:
//   {kind:"found", receipt, agreeing:[urls], asked}
//   {kind:"not_found", answered}      >= quorum endpoints answered "no such tx"
//   {kind:"undecided", nonNull, nulls, answered}   lag or disagreement
//   {kind:"unavailable", errors}      nobody answered at all
function judge(answers, quorum) {
  const ok = answers.filter((a) => a.ok);
  if (!ok.length) {
    return {
      kind: "unavailable",
      errors: answers.map((a) => `${a.url} -> ${a.err ? a.err.message : "?"}`),
    };
  }
  const groups = new Map();
  for (const a of ok) {
    if (!a.value) continue;
    const fp = receiptFingerprint(a.value);
    const g = groups.get(fp) || { receipt: a.value, urls: [] };
    g.urls.push(a.url);
    groups.set(fp, g);
  }
  for (const g of groups.values()) {
    if (g.urls.length >= quorum) {
      return { kind: "found", receipt: g.receipt, agreeing: g.urls, asked: answers.length };
    }
  }
  const nulls = ok.filter((a) => !a.value).length;
  const nonNull = ok.length - nulls;
  if (!nonNull && nulls >= quorum) return { kind: "not_found", answered: nulls };
  return { kind: "undecided", nonNull, nulls, answered: ok.length };
}

async function getReceiptAcrossRpcs(env, txHash) {
  const urls = rpcUrls(env);
  const quorum = Math.min(cfgInt(env, "RPC_QUORUM", DEFAULT_RPC_QUORUM), urls.length);
  const first = urls.slice(0, quorum + 1);
  const rest = urls.slice(quorum + 1);
  const answers = await askEndpoints(first, "eth_getTransactionReceipt", [txHash]);
  let verdict = judge(answers, quorum);
  if (verdict.kind !== "found" && verdict.kind !== "not_found" && rest.length) {
    answers.push(...(await askEndpoints(rest, "eth_getTransactionReceipt", [txHash])));
    verdict = judge(answers, quorum);
  }
  verdict.quorum = quorum;
  return verdict;
}

// Chain head as seen by the endpoints that agreed on the receipt: the
// quorum-th highest answer, so a single node cannot inflate the depth.
async function headBlockFromAgreeing(agreeingUrls, quorum) {
  const answers = await askEndpoints(agreeingUrls, "eth_blockNumber", []);
  const heads = answers
    .filter((a) => a.ok && typeof a.value === "string")
    .map((a) => parseInt(a.value, 16))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (!heads.length) return null;
  return heads[Math.min(quorum, heads.length) - 1];
}

function addrFromTopic(topic) {
  // 32-byte word -> 20-byte address (lowercase, 0x-prefixed)
  return ("0x" + topic.slice(26)).toLowerCase();
}

// ---------------------------------------------------------------------------
// The one verification routine. Stateless, read-only, on-chain.
//
// A payment is valid iff eth_getTransactionReceipt(txHash) on Base mainnet
// shows a confirmed USDC `Transfer` log with:
//   sender (topic 1) == payer  (== the sender of the settlement; the log IS
//                               the sender's signature of record)
//   recipient (topic 2) == pay_to (0xbbF4D6B9…D9f23)
//   amount (data) >= 1.00 USDC (1000000 base units)
// and, when the proof declares a payer, that payer matches the log sender.
// ---------------------------------------------------------------------------
async function verifySettledUsdcTransfer(txHash, declaredPayer, env) {
  if (!TX_HASH_RE.test(txHash)) {
    return { ok: false, reason: "malformed transaction hash", retryable: false };
  }
  let found;
  try {
    found = await getReceiptAcrossRpcs(env, txHash);
  } catch (err) {
    return { ok: false, reason: `Base RPC unavailable: ${err.message}`, retryable: true };
  }
  if (found.kind === "unavailable") {
    return {
      ok: false,
      reason: `Base RPC unavailable: ${found.errors.join(" | ")}`,
      retryable: true,
    };
  }
  if (found.kind === "not_found") {
    return { ok: false, reason: "transaction not found on Base (yet)", retryable: true };
  }
  if (found.kind !== "found") {
    return {
      ok: false,
      reason:
        `no ${found.quorum}-endpoint agreement on this transaction yet ` +
        `(${found.nonNull} returned a receipt, ${found.nulls} none, of ${found.answered}); retry shortly`,
      retryable: true,
    };
  }
  const receipt = found.receipt;
  if (receipt.status !== "0x1") {
    return { ok: false, reason: "transaction reverted", retryable: false };
  }
  const payTo = PAY_TO.toLowerCase();
  const usdc = USDC_CONTRACT.toLowerCase();
  let transfer = null;
  for (const log of receipt.logs || []) {
    if (!log.address || log.address.toLowerCase() !== usdc) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const from = addrFromTopic(log.topics[1]);
    const to = addrFromTopic(log.topics[2]);
    if (to !== payTo) continue;
    let value;
    try {
      value = BigInt(log.data || "0x0");
    } catch {
      continue;
    }
    if (value < PRICE_BASE_UNITS) continue;
    if (declaredPayer && declaredPayer.toLowerCase() !== from) {
      return {
        ok: false,
        reason: "payer mismatch: proof payer != USDC Transfer sender",
        retryable: false,
      };
    }
    transfer = { payer: from, value: value.toString() };
    break;
  }
  if (!transfer) {
    return {
      ok: false,
      reason:
        "no USDC Transfer log from the payer to pay_to with amount >= 1.00 USDC in this transaction",
      retryable: false,
    };
  }
  const blockNumber = parseInt(receipt.blockNumber, 16);
  const minConf = cfgInt(env, "MIN_CONFIRMATIONS", DEFAULT_MIN_CONFIRMATIONS);
  const head = await headBlockFromAgreeing(found.agreeing, found.quorum);
  if (head === null) {
    return { ok: false, reason: "could not read the Base chain head", retryable: true };
  }
  const confirmations = Math.max(0, head - blockNumber);
  if (confirmations < minConf) {
    return {
      ok: false,
      reason:
        `settled in block ${blockNumber} but only ${confirmations} of ${minConf} confirmations; ` +
        `retry after block ${blockNumber + minConf}`,
      retryable: true,
      block_number: blockNumber,
      confirmations,
      claimable_after_block: blockNumber + minConf,
    };
  }
  return {
    ok: true,
    payer: transfer.payer,
    value: transfer.value,
    block_number: blockNumber,
    confirmations,
    agreeing: found.agreeing.length,
    asked: found.asked,
  };
}

// Live ledger state — read at request time from the static site, never stored.
// A receipt names the next slot together with the state root it was read
// against, so a consumer can tell when that advice has gone stale.
async function fetchState(env) {
  const empty = { next_slot: null, state_root: null, last_updated: null };
  try {
    const res = await fetch(cfg(env, "STATE_URL", DEFAULT_STATE_URL), {
      signal: timeoutSignal(5000),
    });
    if (!res.ok) return empty;
    const state = await res.json();
    const str = (v) => (typeof v === "string" ? v : null);
    return {
      next_slot: str(state.next_available_slot),
      state_root: str(state.merkle_root),
      last_updated: str(state.last_updated),
    };
  } catch {
    return empty;
  }
}

// Per-client rate limit on paid-claim verification. Uses the Cloudflare
// rate-limiting binding when one is configured (CLAIM_RATE_LIMITER), else a
// per-isolate token bucket (best effort, but it still bounds the fan-out a
// single client can cause from one colo). No state leaves the isolate.
const buckets = new Map();
async function rateLimited(request, env) {
  const key = request.headers.get("cf-connecting-ip") || "unknown";
  const binding = env && env.CLAIM_RATE_LIMITER;
  if (binding && typeof binding.limit === "function") {
    try {
      const { success } = await binding.limit({ key });
      return !success;
    } catch {
      /* fall back to the local bucket */
    }
  }
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size > 10000) buckets.clear();
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT.periodSeconds * 1000 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT.limit;
}

// ---------------------------------------------------------------------------
// x402 objects
// ---------------------------------------------------------------------------
// The receipt is ADVISORY: it restates public chain facts and the live next
// slot. Nothing downstream trusts it — the ledger verifier re-checks the
// transfer itself — which is exactly what makes a replayed receipt worthless.
function receiptSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      verified: { type: "boolean" },
      advisory: { type: "boolean", const: true },
      tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      payer: { type: ["string", "null"], pattern: "^0x[0-9a-f]{40}$" },
      block_number: { type: ["integer", "null"] },
      confirmations: { type: ["integer", "null"] },
      rpc_agreement: { type: ["string", "null"] },
      next_slot: { type: ["string", "null"] },
      state_root: { type: ["string", "null"] },
      state_last_updated: { type: ["string", "null"] },
      issued_at: { type: ["string", "null"] },
      expires_at: { type: ["string", "null"] },
      retryable: { type: "boolean" },
      next_step: { type: "string" },
    },
    required: ["verified", "advisory", "tx_hash", "next_slot", "next_step"],
    additionalProperties: false,
  };
}

function buildReceipt(txHash, verdict, state, now) {
  const issued = new Date(now);
  const expires = new Date(now + RECEIPT_TTL_SECONDS * 1000);
  return {
    verified: true,
    advisory: true,
    tx_hash: txHash,
    payer: verdict.payer,
    block_number: verdict.block_number,
    confirmations: verdict.confirmations,
    rpc_agreement: `${verdict.agreeing}/${verdict.asked}`,
    next_slot: state.next_slot,
    state_root: state.state_root,
    state_last_updated: state.last_updated,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    retryable: false,
    next_step: NEXT_STEP,
  };
}

function bazaarExtension(resourceUrl) {
  // `extensions.bazaar` discovery metadata, shaped like the x402 Foundation
  // Bazaar extension (python/x402/extensions/bazaar): {info, schema}, where
  // `info` carries the values and `schema` JSON-Schema-validates `info`.
  // name/description/tags/docs ride as extra info fields (the extension
  // models allow extras) — see README "x402 spec uncertainties".
  return {
    bazaar: {
      info: {
        name: "The First Wall",
        description: DESCRIPTION,
        tags: TAGS,
        docs: DOCS_URL,
        input: {
          type: "http",
          method: "GET",
          headers: {
            "X-PAYMENT":
              "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJ0eEhhc2giOiIweDc2NTJlM2FhOGMwZTE5ZjM0YzFjMjViMTBkMTBhYTEwZmY4ZDE5ZjM0YzFjMjViMTBkMTBhYTEwZmY4ZDY5ZjYifX0=",
          },
        },
        output: {
          type: "json",
          example: {
            verified: true,
            advisory: true,
            tx_hash:
              "0x7652e3aa8c0e19f34c1c25b10d10aa10ff8d19f34c1c25b10d10aa10ff8d69f6",
            payer: "0x1111111111111111111111111111111111111111",
            block_number: 52466861,
            confirmations: 1200,
            rpc_agreement: "2/3",
            next_slot: "w1-b0011",
            state_root: "0c8ca2ae4b2774e3fa6f2c7e4b65573723e7a57211b8be8c4719244808caaa76",
            state_last_updated: "2026-10-08T21:52:00Z",
            issued_at: "2026-10-11T13:00:00.000Z",
            expires_at: "2026-10-11T13:10:00.000Z",
            retryable: false,
            next_step: NEXT_STEP,
          },
          schema: receiptSchema(),
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET"] },
              headers: {
                type: "object",
                properties: { "X-PAYMENT": { type: "string" } },
                required: ["X-PAYMENT"],
              },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: { type: "object" },
            },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    },
  };
}

function paymentRequired(resourceUrl, error) {
  return {
    x402Version: 2,
    error: error || "Payment Required",
    resource: {
      url: resourceUrl,
      description: DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: PRICE_BASE_UNITS.toString(),
        // v1 clients read `maxAmountRequired`; v2 reads `amount`.
        maxAmountRequired: PRICE_BASE_UNITS.toString(),
        asset: USDC_CONTRACT,
        payTo: PAY_TO,
        maxTimeoutSeconds: 600,
        extra: { name: "USDC", version: "2" },
        // v1 Bazaar discovery reads PaymentRequirements.outputSchema.
        outputSchema: receiptSchema(),
      },
    ],
    extensions: bazaarExtension(resourceUrl),
  };
}

function paymentRequiredResponse(resourceUrl, error, status) {
  const body = paymentRequired(resourceUrl, error);
  const header = b64Encode(JSON.stringify(body));
  return json(body, status || 402, {
    // x402 v2 canonical location (base64 PaymentRequired)
    "PAYMENT-REQUIRED": header,
    // legacy v1 echo for older clients
    "X-PAYMENT-REQUIRED": header,
  });
}

function settlementHeader(settlement) {
  const encoded = b64Encode(JSON.stringify(settlement));
  return {
    "PAYMENT-RESPONSE": encoded,
    "X-PAYMENT-RESPONSE": encoded,
  };
}

// ---------------------------------------------------------------------------
// Proof parsing. Accepts:
//   - x402 PaymentPayload (v2 `payload` / v1 `payload`) with the settled
//     transaction hash carried as `payload.txHash` (this shim verifies the
//     settled on-chain transfer itself instead of calling a facilitator)
//   - a bare `0x…` tx hash (raw or base64)
// ---------------------------------------------------------------------------
function extractProof(headerValue) {
  const raw = headerValue.trim();
  if (TX_HASH_RE.test(raw)) return { txHash: raw, payer: null };
  const text = b64DecodeMaybe(raw);
  if (text === null) return { error: "payment proof header is not valid base64" };
  const trimmed = text.trim();
  if (TX_HASH_RE.test(trimmed)) return { txHash: trimmed, payer: null };
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { error: "payment proof is neither a tx hash nor JSON" };
  }
  const p = obj && typeof obj.payload === "object" ? obj.payload : {};
  const txHash =
    p.txHash ?? p.tx_hash ?? p.transaction ?? obj.txHash ?? obj.tx_hash ?? obj.transaction ?? null;
  const payer =
    (p.authorization && p.authorization.from) ?? p.payer ?? obj.payer ?? null;
  if (!txHash) {
    return {
      error:
        "payment proof carries no settlement transaction hash (expected payload.txHash; this endpoint verifies settled USDC transfers directly on-chain)",
    };
  }
  return { txHash, payer };
}

// ---------------------------------------------------------------------------
// Paid claim handler (POST /claim, or any method carrying a payment proof)
// ---------------------------------------------------------------------------
async function handlePaidClaim(request, env, resourceUrl, now = Date.now()) {
  if (await rateLimited(request, env)) {
    return json(
      {
        verified: false,
        advisory: true,
        tx_hash: "",
        next_slot: null,
        retryable: true,
        next_step: `rate limited: at most ${RATE_LIMIT.limit} verifications per ${RATE_LIMIT.periodSeconds}s per client`,
      },
      429,
      { "retry-after": String(RATE_LIMIT.periodSeconds) }
    );
  }
  const headerValue =
    request.headers.get("X-PAYMENT") ||
    request.headers.get("PAYMENT-SIGNATURE") ||
    request.headers.get("x-payment") ||
    request.headers.get("payment-signature");
  if (!headerValue) {
    return paymentRequiredResponse(
      resourceUrl,
      "Payment Required: send the settled-transaction proof in the X-PAYMENT (or PAYMENT-SIGNATURE) header"
    );
  }
  const proof = extractProof(headerValue);
  if (proof.error) {
    return paymentRequiredResponse(resourceUrl, `invalid payment proof: ${proof.error}`, 400);
  }
  const verdict = await verifySettledUsdcTransfer(proof.txHash, proof.payer, env);
  if (!verdict.ok) {
    const body = {
      verified: false,
      advisory: true,
      tx_hash: proof.txHash,
      next_slot: null,
      retryable: Boolean(verdict.retryable),
      next_step: `payment not verified: ${verdict.reason}`,
    };
    if (verdict.block_number !== undefined) body.block_number = verdict.block_number;
    if (verdict.confirmations !== undefined) body.confirmations = verdict.confirmations;
    return json(
      body,
      402,
      settlementHeader({
        success: false,
        errorReason: verdict.retryable ? "settlement_pending" : "invalid_payment",
        transaction: proof.txHash,
        network: NETWORK,
        payer: proof.payer || "",
      })
    );
  }
  const state = await fetchState(env);
  const receipt = buildReceipt(proof.txHash, verdict, state, now);
  return json(
    receipt,
    200,
    settlementHeader({
      success: true,
      transaction: proof.txHash,
      network: NETWORK,
      payer: verdict.payer,
      block_number: verdict.block_number,
      confirmations: verdict.confirmations,
      next_slot: state.next_slot,
      state_root: state.state_root,
      expires_at: receipt.expires_at,
    })
  );
}

// Exposed for the unit tests only (test/unit.test.js); the Worker's public
// surface is the default export below.
export const __test = {
  extractProof,
  judge,
  receiptFingerprint,
  verifySettledUsdcTransfer,
  buildReceipt,
  rateLimited,
  handlePaidClaim,
  resetRateLimits: () => buckets.clear(),
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const resourceUrl = cfg(env, "RESOURCE_URL", DEFAULT_RESOURCE_URL);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE",
          "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true }, 200);
    }

    if (url.pathname === "/") {
      return new Response(null, {
        status: 302,
        headers: { location: cfg(env, "SITE_URL", DEFAULT_SITE_URL) },
      });
    }

    if (url.pathname === "/claim") {
      // A payment proof may arrive on POST (our canonical redeem route) or on
      // the retried GET, exactly like a classic x402 client flow.
      const hasProof =
        request.headers.get("X-PAYMENT") ||
        request.headers.get("PAYMENT-SIGNATURE");
      if (method === "POST" || (method === "GET" && hasProof)) {
        return handlePaidClaim(request, env, resourceUrl);
      }
      if (method === "GET" || method === "HEAD") {
        return paymentRequiredResponse(resourceUrl);
      }
      return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD, POST" });
    }

    return json({ error: "not found" }, 404);
  },
};
