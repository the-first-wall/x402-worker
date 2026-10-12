/**
 * The First Wall — x402 claim verifier (Wall 01)
 * ==============================================
 * A minimal, STATELESS, CUSTODY-FREE Cloudflare Worker.
 *
 * What it is:
 *   POST /claim    -> verify the X-PAYMENT (or PAYMENT-SIGNATURE) proof
 *                     STATELESSLY on Base RPC (read-only
 *                     eth_getTransactionReceipt + USDC Transfer log match,
 *                     agreed by a quorum of independent endpoints, at least
 *                     MIN_CONFIRMATIONS deep, for at least the ledger's current
 *                     floor read from state.json for this very verification),
 *                     then return an ADVISORY receipt bound to (tx, next slot,
 *                     state root, expiry). Without a proof: a static 402 that
 *                     points at state.json (the price) and skill.md (the flow);
 *                     nothing is fetched for it.
 *   GET  /claim    -> 405. There is no unauthenticated 402 route: each such
 *                     answer would cost a state.json read, and the price it
 *                     would name is public in state.json (current_floor_usdc).
 *   GET  /healthz  -> {"ok":true}
 *   GET  /         -> 302 to https://thefirstwall.ai
 *
 * What it NEVER does:
 *   - no database, no queue, no cache, no cookies, no sessions
 *   - no secrets, no API keys, no environment-held credentials
 *   - no key custody: it cannot sign, cannot move funds, holds nothing
 *   - no ledger writes: Git (github.com/the-first-wall/ledger) is the ONLY
 *     ledger. The PR flow in https://thefirstwall.ai/skill.md is unchanged.
 *   - no price of its own: the floor is read from state.json for every
 *     verification; when state.json cannot be read the verification fails
 *     closed (503, retryable). It never assumes a price.
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
const USDC_DECIMALS = 6;
// The ledger's price ladder (spec.json#pricing_tiers): the floor is the tier
// price of the next free block and is read from state.json for every
// verification (`current_floor_usdc`, `pricing_tier`). There is no fallback:
// when state.json cannot be read, or names no sane floor, the verification
// fails closed (retryable) instead of assuming a price. The ledger verifier
// is the authority: the payment must cover the tier price of the block it is
// assigned, overpayment is accepted, nothing is refunded.
const MAX_SANE_FLOOR_USDC = 10000;
const PRICE_RULE =
  "pay at least the current floor (the tier price of the block you are assigned); " +
  "overpayment is accepted; no refunds; an unused settlement stays valid for a later claim by the same wallet";
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
  // UTF-8 safe: btoa alone throws on any character outside Latin-1.
  let bin = "";
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
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
function usdcToUnits(usdc) {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
}
function unitsToUsdc(units) {
  return Number(units) / 10 ** USDC_DECIMALS;
}
function usdcLabel(units) {
  return `${unitsToUsdc(units).toFixed(2)} USDC`;
}
// The price a proof is checked against: the ledger's current floor as
// state.json names it, or null — never a guess. A null price fails the
// verification closed (handlePaidClaim answers 503, retryable).
function priceFromState(state) {
  const floor = state && typeof state.floor_usdc === "number" ? state.floor_usdc : null;
  if (floor === null || !Number.isFinite(floor) || floor <= 0 || floor > MAX_SANE_FLOOR_USDC) {
    return null;
  }
  const units = usdcToUnits(floor);
  return { units, usdc: unitsToUsdc(units), tier: state.pricing_tier || null, source: "state.json" };
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
//   amount (data) >= the current floor (price.units, read from state.json)
// and, when the proof declares a payer, that payer matches the log sender.
// ---------------------------------------------------------------------------
async function verifySettledUsdcTransfer(txHash, declaredPayer, env, price) {
  if (!price) {
    return { ok: false, reason: "price unavailable: state.json could not be read", retryable: true };
  }
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
  // The largest USDC transfer to pay_to in this transaction (from the declared
  // payer, when one is declared) is the settlement; it must cover the floor.
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
    if (declaredPayer && declaredPayer.toLowerCase() !== from) {
      return {
        ok: false,
        reason: "payer mismatch: proof payer != USDC Transfer sender",
        retryable: false,
      };
    }
    if (!transfer || value > transfer.units) transfer = { payer: from, units: value };
  }
  if (!transfer) {
    return {
      ok: false,
      reason: "no USDC Transfer log from the payer to pay_to in this transaction",
      retryable: false,
    };
  }
  if (transfer.units < price.units) {
    return {
      ok: false,
      reason:
        `paid ${usdcLabel(transfer.units)}; the current floor is ${usdcLabel(price.units)}` +
        (price.tier ? ` (${price.tier} tier)` : "") +
        ". No refunds: settle the full price in one transaction and claim with that one; " +
        "the ledger verifier enforces the same ladder",
      retryable: false,
      amount_usdc: unitsToUsdc(transfer.units),
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
    value: transfer.units.toString(),
    amount_usdc: unitsToUsdc(transfer.units),
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
  const empty = {
    next_slot: null,
    state_root: null,
    last_updated: null,
    floor_usdc: null,
    pricing_tier: null,
    error: null,
  };
  try {
    const res = await fetch(cfg(env, "STATE_URL", DEFAULT_STATE_URL), {
      signal: timeoutSignal(5000),
    });
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };
    const state = await res.json();
    const str = (v) => (typeof v === "string" ? v : null);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      next_slot: str(state.next_available_slot),
      state_root: str(state.merkle_root),
      last_updated: str(state.last_updated),
      floor_usdc: num(state.current_floor_usdc),
      pricing_tier: str(state.pricing_tier),
      error: num(state.current_floor_usdc) === null ? "no current_floor_usdc" : null,
    };
  } catch (err) {
    return { ...empty, error: err && err.message ? err.message : String(err) };
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
      amount_usdc: { type: ["number", "null"] },
      floor_usdc: { type: ["number", "null"] },
      pricing_tier: { type: ["string", "null"] },
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

function buildReceipt(txHash, verdict, state, now, price) {
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
    amount_usdc: verdict.amount_usdc ?? null,
    floor_usdc: price.usdc,
    pricing_tier: price.tier,
    next_slot: state.next_slot,
    state_root: state.state_root,
    state_last_updated: state.last_updated,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    retryable: false,
    next_step: NEXT_STEP,
  };
}

// The one unauthenticated answer, and it is static: no state.json read, no
// RPC. Every such answer is free for the caller, so it must be free for the
// worker too; the amount it does not name is public in state.json.
function proofRequired(env, resourceUrl, error, status) {
  const body = {
    x402Version: 2,
    error: error || "Payment Required",
    resource: {
      url: resourceUrl,
      description: DESCRIPTION,
      mimeType: "application/json",
    },
    // No `accepts` entry: this worker names no amount of its own. Read the
    // ledger's floor from state.json, settle it on Base, then POST the proof.
    accepts: [],
    price: {
      source: cfg(env, "STATE_URL", DEFAULT_STATE_URL),
      field: "current_floor_usdc",
      asset: USDC_CONTRACT,
      network: NETWORK,
      payTo: PAY_TO,
      rule: PRICE_RULE,
    },
    proof:
      "POST /claim with the settled transaction hash in the X-PAYMENT (or PAYMENT-SIGNATURE) header: " +
      "an x402 PaymentPayload carrying payload.txHash, or the bare 0x hash",
    docs: DOCS_URL,
    outputSchema: receiptSchema(),
  };
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
// Paid claim handler (POST /claim). Cheapest checks first: a request without
// a proof, or with a malformed one, is answered from constants and never
// reaches the rate limiter, state.json or an RPC endpoint.
// ---------------------------------------------------------------------------
async function handlePaidClaim(request, env, resourceUrl, now = Date.now()) {
  const headerValue =
    request.headers.get("X-PAYMENT") ||
    request.headers.get("PAYMENT-SIGNATURE") ||
    request.headers.get("x-payment") ||
    request.headers.get("payment-signature");
  if (!headerValue) {
    return proofRequired(
      env,
      resourceUrl,
      "Payment Required: settle the ledger's current floor (state.json current_floor_usdc) on Base, " +
        "then send the settled-transaction proof in the X-PAYMENT (or PAYMENT-SIGNATURE) header",
      402
    );
  }
  const proof = extractProof(headerValue);
  if (proof.error) {
    return proofRequired(env, resourceUrl, `invalid payment proof: ${proof.error}`, 400);
  }
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
  // The live floor, read for this verification: what the proof is checked
  // against. No floor, no verdict — the worker never assumes a price.
  const state = await fetchState(env);
  const price = priceFromState(state);
  if (!price) {
    return json(
      {
        verified: false,
        advisory: true,
        tx_hash: proof.txHash,
        next_slot: null,
        retryable: true,
        next_step:
          `price unavailable: state.json could not be read (${state.error || "unknown"}); ` +
          "nothing was verified, retry shortly",
      },
      503,
      { "retry-after": "60" }
    );
  }
  const verdict = await verifySettledUsdcTransfer(proof.txHash, proof.payer, env, price);
  if (!verdict.ok) {
    const body = {
      verified: false,
      advisory: true,
      tx_hash: proof.txHash,
      floor_usdc: price.usdc,
      pricing_tier: price.tier,
      next_slot: null,
      retryable: Boolean(verdict.retryable),
      next_step: `payment not verified: ${verdict.reason}`,
    };
    if (verdict.amount_usdc !== undefined) body.amount_usdc = verdict.amount_usdc;
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
  const receipt = buildReceipt(proof.txHash, verdict, state, now, price);
  return json(
    receipt,
    200,
    settlementHeader({
      success: true,
      transaction: proof.txHash,
      network: NETWORK,
      payer: verdict.payer,
      amount_usdc: verdict.amount_usdc,
      floor_usdc: price.usdc,
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
  fetchState,
  priceFromState,
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
          "access-control-allow-methods": "POST, OPTIONS",
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
      if (method === "POST") {
        return handlePaidClaim(request, env, resourceUrl);
      }
      // No GET, no HEAD: an unauthenticated 402 would cost a state.json read
      // per hit, and the price it would name is public in state.json already.
      // Answered from constants; nothing is fetched.
      return json(
        {
          error: "method not allowed: POST the payment proof; the price is public in state.json",
          price: { source: cfg(env, "STATE_URL", DEFAULT_STATE_URL), field: "current_floor_usdc" },
          docs: DOCS_URL,
        },
        405,
        { allow: "POST, OPTIONS" }
      );
    }

    return json({ error: "not found" }, 404);
  },
};
