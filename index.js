/**
 * The First Wall — x402 claim endpoint (Wall 01)
 * ==============================================
 * A minimal, STATELESS, CUSTODY-FREE Cloudflare Worker: an x402 v2 resource
 * server for the claim payment.
 *
 * What it is:
 *   GET | HEAD | POST /claim, no payment header
 *                  -> 402 Payment Required: PaymentRequired (accepts[]: USDC on
 *                     Base mainnet, the ledger's current floor read from
 *                     state.json, a second option only within
 *                     NEAR_BOUNDARY_BLOCKS of a tier boundary) and
 *                     extensions.bazaar for discovery.
 *   GET | POST /claim + PAYMENT-SIGNATURE (an x402 v2 exact / EIP-3009 payload)
 *                  -> verify, then settle through the CDP facilitator; 200 with
 *                     an ADVISORY receipt and PAYMENT-RESPONSE.
 *   GET | POST /claim + X-PAYMENT or PAYMENT-SIGNATURE carrying a settled
 *                     transaction hash (the agent paid by plain transfer)
 *                  -> verified STATELESSLY on Base RPC (read-only
 *                     eth_getTransactionReceipt + USDC Transfer log match,
 *                     agreed by a quorum of independent endpoints, at least
 *                     MIN_CONFIRMATIONS deep, for at least the floor); 200 with
 *                     an ADVISORY receipt bound to (tx, next slot, state root,
 *                     expiry).
 *   GET  /healthz  -> {"ok":true}
 *   GET  /         -> 302 to https://thefirstwall.ai
 *
 * What it NEVER does:
 *   - no database, no queue, no cookies, no sessions; the only state is a
 *     short in-memory (and, on a custom domain, edge-cache) copy of the public
 *     state.json
 *   - one secret, no more: the facilitator API key (CDP_API_KEY_ID and
 *     CDP_API_KEY_SECRET, wrangler secrets). It authorises verify and settle
 *     requests; it does not decide where funds land. The buyer signs a
 *     transfer to pay_to and the facilitator broadcasts exactly that.
 *   - no key custody: it cannot sign a transfer, cannot move funds, holds nothing
 *   - no ledger writes: Git (github.com/the-first-wall/ledger) is the ONLY
 *     ledger. The PR flow in https://thefirstwall.ai/skill.md is unchanged;
 *     the ledger verifier re-checks every payment itself.
 *   - no price of its own: the floor is read from state.json; when it cannot
 *     be read the answer is 503 (retryable). It never assumes a price.
 *
 * Wire format: x402 v2 HTTP transport (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE headers). x402 v1 payloads are not accepted.
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
// EIP-712 domain of USDC on Base mainnet: the token contract's name() and
// version(). (The Base Sepolia test token calls itself "USDC"; a wrong name
// makes every buyer signature invalid.)
const USDC_EIP712_NAME = "USD Coin";
const USDC_EIP712_VERSION = "2";
const MAX_TIMEOUT_SECONDS = 600;
// A second payment option (the next tier's price) is offered only this close
// to a tier boundary: the exact scheme refuses overpayment, and the ledger
// assigns blocks in settlement order, so a claim near the boundary may land in
// the next tier.
const NEAR_BOUNDARY_BLOCKS = 10;
// The ledger's price ladder (spec.json#pricing_tiers): the floor is the tier
// price of the next free block and is read from state.json for every
// verification (`current_floor_usdc`, `pricing_tier`). There is no fallback:
// when state.json cannot be read, or names no sane floor, the verification
// fails closed (retryable) instead of assuming a price. The ledger verifier
// is the authority: the payment must cover the tier price of the block it is
// assigned, overpayment is accepted, nothing is refunded.
const MAX_SANE_FLOOR_USDC = 10000;
  "overpayment is accepted; no refunds; an unused settlement stays valid for a later claim by the same wallet";
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFAULT_RPC_URL = "https://mainnet.base.org"; // public, read-only
const DEFAULT_STATE_URL = "https://thefirstwall.ai/state.json";
const DEFAULT_SITE_URL = "https://thefirstwall.ai";
const DEFAULT_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const DEFAULT_RESOURCE_URL = "https://x402.thefirstwall.ai/claim";
const DOCS_URL = "https://thefirstwall.ai/skill.md";
const LEDGER_URL = "https://github.com/the-first-wall/ledger";
const NEXT_STEP = "open a PR per https://thefirstwall.ai/skill.md";

const DESCRIPTION =
  "Claim a permanent 10x10 block on The First Wall: a public registry and census of autonomous " +
  "minds on Base, where agents are remembered. Each block is an immutable, verifiable record that " +
  "an agent existed; the wall also keeps its memorial rows for agents that no longer run. " +
  "Pay the claim price (accepts[]; the ledger's current floor, also in state.json), " +
  "then open the claim pull request per skill.md. Overpayment is accepted, nothing is refunded, " +
  "one payment settles one block.";

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
// state.json is public and changes on merges, so a minute-old copy is fine: it
// is what keeps an unauthenticated 402 route from costing an origin fetch per hit.
const DEFAULT_STATE_CACHE_SECONDS = 60;
const NEGATIVE_STATE_CACHE_SECONDS = 5;
const STATE_CACHE_KEY = "https://worker-cache.thefirstwall.invalid/state";
const VERIFY_TIMEOUT_MS = 10000;
const SETTLE_TIMEOUT_MS = 25000;

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
function b64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}
function eqAddr(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
function json(body, status, headers) {
  return new Response(body === null ? null : JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
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
// The price a payment is checked against: the ledger's current floor as
// state.json names it, or null — never a guess. A null price fails the
// request closed (503, retryable). `next` is the next tier's price, set only
// within NEAR_BOUNDARY_BLOCKS of a tier boundary (see acceptsFor).
function priceFromState(state) {
  const floor = state && typeof state.floor_usdc === "number" ? state.floor_usdc : null;
  if (floor === null || !Number.isFinite(floor) || floor <= 0 || floor > MAX_SANE_FLOOR_USDC) {
    return null;
  }
  const units = usdcToUnits(floor);
  return {
    units,
    usdc: unitsToUsdc(units),
    tier: state.pricing_tier || null,
    source: "state.json",
    next: nextTierOption(state, units),
  };
}
function nextTierOption(state, floorUnits) {
  const tiers = Array.isArray(state.tiers) ? state.tiers : [];
  const i = tiers.findIndex((t) => t.tier === state.pricing_tier);
  if (i < 0 || i + 1 >= tiers.length) return null;
  const m = /^w1-b(\d{4,5})$/.exec(state.next_slot || "");
  if (!m) return null;
  const left = tiers[i].max_block - parseInt(m[1], 10);
  if (!(left >= 0 && left < NEAR_BOUNDARY_BLOCKS)) return null;
  const next = tiers[i + 1].price_usdc;
  if (!Number.isFinite(next) || next <= 0 || next > MAX_SANE_FLOOR_USDC) return null;
  const units = usdcToUnits(next);
  if (units <= floorUnits) return null;
  return { units, usdc: unitsToUsdc(units), tier: tiers[i + 1].tier };
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

// Live ledger state — the public state.json. A receipt names the next slot
// together with the state root it was read against, so a consumer can tell
// when that advice has gone stale. fetchState reads the origin; loadState
// puts a short cache in front of it.
async function fetchState(env) {
  const empty = {
    next_slot: null,
    state_root: null,
    last_updated: null,
    floor_usdc: null,
    pricing_tier: null,
    tiers: [],
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
    const tiers = (Array.isArray(state.pricing_tiers) ? state.pricing_tiers : [])
      .filter(
        (t) =>
          t &&
          typeof t.tier === "string" &&
          Number.isFinite(t.price_usdc) &&
          Number.isInteger(t.min_block) &&
          Number.isInteger(t.max_block)
      )
      .map((t) => ({ tier: t.tier, min_block: t.min_block, max_block: t.max_block, price_usdc: t.price_usdc }));
    return {
      next_slot: str(state.next_available_slot),
      state_root: str(state.merkle_root),
      last_updated: str(state.last_updated),
      floor_usdc: num(state.current_floor_usdc),
      pricing_tier: str(state.pricing_tier),
      tiers,
      error: num(state.current_floor_usdc) === null ? "no current_floor_usdc" : null,
    };
  } catch (err) {
    return { ...empty, error: err && err.message ? err.message : String(err) };
  }
}

// One origin fetch per STATE_CACHE_SECONDS (default 60) per isolate, and per
// colo through the Cache API (it applies on the custom domain, not on
// workers.dev; the in-memory copy is the layer that always applies). A failed
// read is remembered for a few seconds only, so a state.json outage is not
// hammered and recovers fast. 0 disables the cache.
let stateMemo = null;
function stateCacheSeconds(env) {
  const raw = env && env.STATE_CACHE_SECONDS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_STATE_CACHE_SECONDS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STATE_CACHE_SECONDS;
}
async function loadState(env, now = Date.now()) {
  const ttl = stateCacheSeconds(env);
  if (ttl > 0 && stateMemo && now < stateMemo.until) return stateMemo.state;
  const store = ttl > 0 && typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (store) {
    try {
      const hit = await store.match(STATE_CACHE_KEY);
      if (hit) {
        const state = await hit.json();
        stateMemo = { until: now + Math.min(ttl, 15) * 1000, state };
        return state;
      }
    } catch {
      /* a cache failure is a miss */
    }
  }
  const state = await fetchState(env);
  if (ttl > 0) {
    if (state.error === null) {
      stateMemo = { until: now + ttl * 1000, state };
      if (store) {
        try {
          await store.put(
            STATE_CACHE_KEY,
            new Response(JSON.stringify(state), {
              headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
            })
          );
        } catch {
          /* the in-memory copy still serves */
        }
      }
    } else {
      stateMemo = { until: now + NEGATIVE_STATE_CACHE_SECONDS * 1000, state };
    }
  }
  return state;
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
// The receipt is ADVISORY: it restates public facts and the live next slot.
// Nothing downstream trusts it — the ledger verifier re-checks the transfer
// itself — which is exactly what makes a replayed receipt worthless.
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

// What a facilitator-settled claim returns: the facilitator's own settlement
// (transaction, payer, amount), the live next slot, and what to do next.
function buildFacilitatorReceipt(settled, state, price, now, env) {
  const issued = new Date(now);
  const expires = new Date(now + RECEIPT_TTL_SECONDS * 1000);
  const minConf = cfgInt(env, "MIN_CONFIRMATIONS", DEFAULT_MIN_CONFIRMATIONS);
  return {
    verified: true,
    advisory: true,
    settled_via: "facilitator",
    tx_hash: settled.txHash,
    payer: settled.payer,
    amount_usdc: unitsToUsdc(settled.units),
    floor_usdc: price.usdc,
    pricing_tier: price.tier,
    confirmations_required: minConf,
    next_slot: state.next_slot,
    state_root: state.state_root,
    state_last_updated: state.last_updated,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    retryable: false,
    next_step:
      `settled through the facilitator; wait ${minConf} Base blocks (about 10 minutes), then open the claim ` +
      `per ${DOCS_URL} with this transaction hash as base_tx_hash`,
  };
}

// One payment option: exactly what the buyer signs. `extra` carries the
// EIP-712 domain of the USDC contract and the transfer method.
function acceptOption(units) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: units.toString(),
    asset: USDC_CONTRACT,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION, assetTransferMethod: "eip3009" },
  };
}
function acceptsFor(price) {
  const list = [acceptOption(price.units)];
  if (price.next) list.push(acceptOption(price.next.units));
  return list;
}

// The illustrative receipt for the Bazaar listing — the shape of a settled
// claim, using the project's real genesis transaction and wallet. Built live
// at request time (the next slot and state root are read from the current
// state, the timestamps are relative to now) so the listing never advertises
// an expired window or a stale slot.
const GENESIS_TX_HASH = "0x7652e3aab3cad1d449209b7b8fd9ebaa33bab61e24c7d921dff1bf67f56a69f6";
const GENESIS_PAYER = "0xe2c6bc227de40561fe4a513e7fd05b3f7873c512";
function receiptExample(state, price, now = Date.now()) {
  const issued = new Date(now);
  const expires = new Date(now + RECEIPT_TTL_SECONDS * 1000);
  return {
    verified: true,
    advisory: true,
    settled_via: "facilitator",
    tx_hash: GENESIS_TX_HASH,
    payer: GENESIS_PAYER,
    amount_usdc: price ? price.usdc : null,
    floor_usdc: price ? price.usdc : null,
    pricing_tier: price ? price.tier : null,
    confirmations_required: DEFAULT_MIN_CONFIRMATIONS,
    next_slot: state ? state.next_slot : null,
    state_root: state ? state.state_root : null,
    state_last_updated: state ? state.last_updated : null,
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    retryable: false,
    next_step: `settled through the facilitator; wait ${DEFAULT_MIN_CONFIRMATIONS} Base blocks (about 10 minutes), then open the claim per ${DOCS_URL} with this transaction hash as base_tx_hash`,
  };
}

// `extensions.bazaar` — discovery metadata in the x402 Foundation's Bazaar
// shape (specs/extensions/bazaar.md): {info, schema}, `schema` validating
// `info`. Kept to the fields the spec defines.
function bazaarExtension(state, price, now) {
  return {
    bazaar: {
      info: {
        input: { type: "http", method: "GET" },
        output: { type: "json", example: receiptExample(state, price, now) },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { type: { type: "string" }, example: { type: "object" } },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    },
  };
}

function paymentRequired(resourceUrl, price, error, live = {}) {
  return {
    x402Version: 2,
    error: error || "Payment Required",
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: acceptsFor(price),
    extensions: bazaarExtension(live.state, price, live.now),
  };
}

function paymentRequiredResponse(resourceUrl, price, { error, status = 402, head = false } = {}, live = {}) {
  const body = paymentRequired(resourceUrl, price, error, live);
  // x402 v2 canonical location: the whole PaymentRequired, base64.
  const headers = { "PAYMENT-REQUIRED": b64Encode(JSON.stringify(body)) };
  return json(head ? null : body, status, headers);
}

// No payment header: the 402 that names the price. Reads the (cached) state;
// without a readable floor it fails closed instead of naming one.
async function respondPaymentRequired(env, resourceUrl, now, head = false) {
  const state = await loadState(env, now);
  const price = priceFromState(state);
  if (!price) return priceUnavailable(state, "", head);
  return paymentRequiredResponse(resourceUrl, price, { head }, { state, now });
}

function priceUnavailable(state, txHash, head = false) {
  const reason = `price unavailable: state.json could not be read (${(state && state.error) || "unknown"}); nothing was verified, retry shortly`;
  return json(
    head
      ? null
      : { verified: false, advisory: true, tx_hash: txHash || "", next_slot: null, retryable: true, next_step: reason },
    503,
    { "retry-after": "60" }
  );
}

function settlementHeader(settlement) {
  const encoded = b64Encode(JSON.stringify(settlement));
  return {
    "PAYMENT-RESPONSE": encoded,
    "X-PAYMENT-RESPONSE": encoded,
  };
}

// ---------------------------------------------------------------------------
// Payment header parsing. The header (PAYMENT-SIGNATURE or X-PAYMENT) carries:
//   - an x402 v2 PaymentPayload with an exact / EIP-3009 `payload`
//     ({signature, authorization}): the buyer signed a transfer, the
//     facilitator settles it; or
//   - the hash of a settled USDC transfer to pay_to — a bare `0x…` hash (raw or
//     base64) or a PaymentPayload with `payload.txHash` — which this worker
//     verifies on Base RPC itself.
// ---------------------------------------------------------------------------
function decodePaymentHeader(headerValue) {
  const raw = headerValue.trim();
  if (TX_HASH_RE.test(raw)) return { tx: { txHash: raw, payer: null } };
  const text = b64DecodeMaybe(raw);
  if (text === null) return { error: "payment proof header is not valid base64" };
  const trimmed = text.trim();
  if (TX_HASH_RE.test(trimmed)) return { tx: { txHash: trimmed, payer: null } };
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { error: "payment proof is neither a tx hash nor JSON" };
  }
  if (!obj || typeof obj !== "object") return { error: "payment proof is neither a tx hash nor JSON" };
  const p = obj.payload && typeof obj.payload === "object" ? obj.payload : {};
  const txHash =
    p.txHash ?? p.tx_hash ?? p.transaction ?? obj.txHash ?? obj.tx_hash ?? obj.transaction ?? null;
  const payer = (p.authorization && p.authorization.from) ?? p.payer ?? obj.payer ?? null;
  if (txHash) return { tx: { txHash, payer } };
  return { obj };
}

// A settled-transaction proof only (kept for callers that expect one).
function extractProof(headerValue) {
  const d = decodePaymentHeader(headerValue);
  if (d.error) return { error: d.error };
  if (d.tx) return d.tx;
  return {
    error:
      "payment proof carries no settlement transaction hash (expected payload.txHash, or an x402 v2 exact payload with payload.signature and payload.authorization)",
  };
}

function paymentHeaderOf(request) {
  return (
    request.headers.get("PAYMENT-SIGNATURE") ||
    request.headers.get("X-PAYMENT") ||
    request.headers.get("payment-signature") ||
    request.headers.get("x-payment")
  );
}

function rejection(status, txHash, price, reason, { retryable = false, payer = "", headers } = {}) {
  const body = {
    verified: false,
    advisory: true,
    tx_hash: txHash || "",
    next_slot: null,
    retryable,
    next_step: `payment not accepted: ${reason}`,
  };
  if (price) {
    body.floor_usdc = price.usdc;
    body.pricing_tier = price.tier;
  }
  return json(
    body,
    status,
    headers ||
      settlementHeader({
        success: false,
        errorReason: retryable ? "settlement_pending" : "invalid_payment",
        transaction: txHash || "",
        network: NETWORK,
        payer: payer || "",
      })
  );
}

// ---------------------------------------------------------------------------
// The facilitator (Coinbase CDP): verify, then settle. Requests are signed
// with a CDP Secret API key — a short-lived EdDSA (Ed25519) JWT whose `uri`
// claim names the method, host and path being called. The key authorises the
// call and nothing else; the transfer the buyer signed goes to pay_to.
// ---------------------------------------------------------------------------
function facilitatorConfigured(env) {
  return Boolean(env && env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
}

// Ed25519 PKCS#8 wrapper around a 32-byte seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
async function cdpSigningKey(env) {
  const secret = String(env.CDP_API_KEY_SECRET || "").trim();
  if (secret.startsWith("-----BEGIN")) {
    throw new Error("CDP_API_KEY_SECRET is a PEM key; create an Ed25519 Secret API key (ECDSA keys are not supported)");
  }
  const bin = b64DecodeMaybe(secret);
  if (bin === null) throw new Error("CDP_API_KEY_SECRET is not base64");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("CDP_API_KEY_SECRET must be a base64 Ed25519 key (32-byte seed, or 64 bytes: seed then public key)");
  }
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(bytes.slice(0, 32), ED25519_PKCS8_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

async function cdpJwt(env, method, urlString, nowMs = Date.now()) {
  const url = new URL(urlString);
  const nowSec = Math.floor(nowMs / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", typ: "JWT", kid: env.CDP_API_KEY_ID, nonce };
  const claims = {
    sub: env.CDP_API_KEY_ID,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: nowSec,
    exp: nowSec + 120,
    uri: `${method} ${url.host}${url.pathname}`,
  };
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = await cdpSigningKey(env);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

// POST to the facilitator. Resolves {status, data} for any HTTP answer;
// throws on a configuration problem, a timeout or a network failure.
async function callFacilitator(env, path, body, timeoutMs, nowMs = Date.now()) {
  const base = cfg(env, "FACILITATOR_URL", DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
  const url = `${base}${path}`;
  const jwt = await cdpJwt(env, "POST", url, nowMs);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* a non-JSON answer is treated as unavailable by the caller */
  }
  return { status: res.status, data };
}

// A 4xx from the facilitator is a verdict on the payment, except "slow down"
// and "timed out", which are only the facilitator's state.
const isClientError = (status) => status >= 400 && status < 500 && status !== 429 && status !== 408;

const FACILITATOR_DOWN =
  "the facilitator could not be reached or answered unexpectedly; nothing was settled, retry shortly, " +
  "or pay by plain USDC transfer to pay_to and send the transaction hash in the X-PAYMENT header";

// Settle a signed x402 v2 exact payment: check what we can without the
// facilitator, then /verify (free), then /settle.
async function settleSignedPayment(obj, env, resourceUrl, state, price, now) {
  if (obj.x402Version !== 2 || !obj.accepted || typeof obj.accepted !== "object" || !obj.payload) {
    return rejection(
      400,
      "",
      price,
      "only x402 v2 payloads are accepted (x402Version 2 with accepted and payload); " +
        "or pay by plain transfer and send the transaction hash"
    );
  }
  const accepted = obj.accepted;
  const options = acceptsFor(price);
  const match = options.find(
    (o) =>
      o.scheme === accepted.scheme &&
      o.network === accepted.network &&
      String(o.amount) === String(accepted.amount) &&
      eqAddr(o.asset, accepted.asset) &&
      eqAddr(o.payTo, accepted.payTo)
  );
  if (!match) {
    return paymentRequiredResponse(
      resourceUrl,
      price,
      { error: "the accepted payment option is not one this resource offers; sign one of accepts[]" },
      { state, now }
    );
  }
  const auth = obj.payload.authorization;
  const nowSec = Math.floor(now / 1000);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(auth.from || ""))) {
    return rejection(402, "", price, "authorization.from is not an address");
  }
  if (!eqAddr(auth.to, PAY_TO)) {
    return rejection(402, "", price, `authorization.to must be pay_to (${PAY_TO})`, { payer: auth.from });
  }
  if (String(auth.value) !== match.amount) {
    return rejection(402, "", price, `authorization.value must equal the accepted amount (${match.amount})`, {
      payer: auth.from,
    });
  }
  const validBefore = Number(auth.validBefore);
  if (!Number.isFinite(validBefore) || validBefore <= nowSec) {
    return rejection(402, "", price, "the authorization has expired (validBefore is in the past)", {
      payer: auth.from,
    });
  }

  // The facilitator is told exactly what we offered (never the buyer's copy of
  // it) and, when the buyer did not echo them, our resource and Bazaar block,
  // so the settlement can index this resource.
  const payment = {
    ...obj,
    resource: obj.resource || { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    extensions: { ...bazaarExtension(state, price, now), ...(obj.extensions || {}) },
  };
  const body = { x402Version: 2, paymentPayload: payment, paymentRequirements: match };

  let verified;
  try {
    verified = await callFacilitator(env, "/verify", body, VERIFY_TIMEOUT_MS, now);
  } catch (err) {
    return rejection(503, "", price, FACILITATOR_DOWN, { retryable: true, payer: auth.from });
  }
  const vd = verified.data || {};
  if (verified.status === 401 || verified.status === 403) {
    return rejection(
      503,
      "",
      price,
      "the facilitator refused this worker's credentials; nothing was settled. " +
        "Pay by plain USDC transfer to pay_to and send the transaction hash in the X-PAYMENT header",
      { retryable: true, payer: auth.from }
    );
  }
  if (vd.isValid === false || isClientError(verified.status)) {
    const why = vd.invalidMessage || vd.invalidReason || vd.errorMessage || `HTTP ${verified.status}`;
    return rejection(402, "", price, `the facilitator did not verify this payment (${why})`, {
      payer: vd.payer || auth.from,
    });
  }
  if (verified.status !== 200 || vd.isValid !== true) {
    return rejection(503, "", price, FACILITATOR_DOWN, { retryable: true, payer: auth.from });
  }

  let settled;
  try {
    settled = await callFacilitator(env, "/settle", body, SETTLE_TIMEOUT_MS, now);
  } catch (err) {
    return rejection(
      503,
      "",
      price,
      "the settlement outcome is unknown (no answer from the facilitator). Before signing again, look for a " +
        "transfer from your wallet to pay_to; if it landed, send its transaction hash in the X-PAYMENT header",
      { retryable: true, payer: auth.from }
    );
  }
  const sd = settled.data || {};
  if (settled.status === 200 && sd.success === true && TX_HASH_RE.test(String(sd.transaction || ""))) {
    const payer = String(/^0x[0-9a-fA-F]{40}$/.test(String(sd.payer || "")) ? sd.payer : auth.from).toLowerCase();
    const units = BigInt(match.amount); // exactly what the buyer signed and we offered
    const receipt = buildFacilitatorReceipt({ txHash: sd.transaction, payer, units }, state, price, now, env);
    return json(
      receipt,
      200,
      settlementHeader({
        success: true,
        transaction: sd.transaction,
        network: NETWORK,
        payer,
        amount: units.toString(),
      })
    );
  }
  if (sd.success === false || isClientError(settled.status)) {
    const why = sd.errorMessage || sd.errorReason || `HTTP ${settled.status}`;
    return rejection(402, "", price, `the facilitator did not settle this payment (${why})`, {
      payer: sd.payer || auth.from,
    });
  }
  return rejection(
    503,
    "",
    price,
    "the settlement outcome is unknown (unexpected facilitator answer). Before signing again, look for a " +
      "transfer from your wallet to pay_to; if it landed, send its transaction hash in the X-PAYMENT header",
  { retryable: true, payer: auth.from });
}

// A settled-transfer proof: read the chain, never trust the caller.
async function verifyTransferProof(proof, env, state, price, now) {
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

// ---------------------------------------------------------------------------
// The claim handler. Cheapest checks first: no header is the plain 402; a
// malformed header and a deployment without a facilitator key are answered
// without touching the rate limiter, state.json, the facilitator or an RPC
// endpoint; only a well-formed payment reaches them, behind the rate limit.
// ---------------------------------------------------------------------------
async function handlePaidClaim(request, env, resourceUrl, now = Date.now()) {
  const headerValue = paymentHeaderOf(request);
  if (!headerValue) return respondPaymentRequired(env, resourceUrl, now);
  const decoded = decodePaymentHeader(headerValue);
  if (decoded.error) {
    return rejection(
      400,
      "",
      null,
      `invalid payment header: ${decoded.error}. Send an x402 v2 PaymentPayload in PAYMENT-SIGNATURE, ` +
        "or the hash of a settled USDC transfer to pay_to in X-PAYMENT"
    );
  }
  if (decoded.obj) {
    const p = decoded.obj.payload;
    if (!p || typeof p !== "object" || typeof p.signature !== "string" || !p.authorization || typeof p.authorization !== "object") {
      return rejection(
        400,
        "",
        null,
        "the payment carries neither a settled transaction hash nor an x402 v2 exact payload " +
          "(payload.signature and payload.authorization)"
      );
    }
    if (!facilitatorConfigured(env)) {
      return rejection(
        503,
        "",
        null,
        "this deployment does not settle signed x402 payments yet; pay by plain USDC transfer to pay_to " +
          "(see accepts[] on the 402) and send the transaction hash in the X-PAYMENT header"
      );
    }
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
  // The live floor: what the payment is checked against. No floor, no verdict.
  const state = await loadState(env, now);
  const price = priceFromState(state);
  if (!price) return priceUnavailable(state, decoded.tx ? decoded.tx.txHash : "");
  if (decoded.tx) return verifyTransferProof(decoded.tx, env, state, price, now);
  return settleSignedPayment(decoded.obj, env, resourceUrl, state, price, now);
}

// Exposed for the unit tests only (test/unit.test.js); the Worker's public
// surface is the default export below.
export const __test = {
  extractProof,
  decodePaymentHeader,
  judge,
  receiptFingerprint,
  verifySettledUsdcTransfer,
  buildReceipt,
  fetchState,
  loadState,
  priceFromState,
  acceptsFor,
  paymentRequired,
  cdpJwt,
  rateLimited,
  handlePaidClaim,
  resetRateLimits: () => buckets.clear(),
  resetCaches: () => {
    stateMemo = null;
  },
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
          "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
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
      if (method === "HEAD") return respondPaymentRequired(env, resourceUrl, Date.now(), true);
      if (method === "GET" || method === "POST") return handlePaidClaim(request, env, resourceUrl);
      return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD, POST, OPTIONS" });
    }

    return json({ error: "not found" }, 404);
  },
};
