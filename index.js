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
 *                     eth_getTransactionReceipt + USDC Transfer log match),
 *                     then return a receipt with the live next slot.
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

// Receipt lookup across endpoints. Primary first (polite, cheap); if it flaked,
// the fallbacks run in parallel and the first non-null receipt wins (chain
// truth). A throttled or lagging node can therefore never produce a false
// negative for a just-settled payment. Worst-case wall time is bounded.
async function getReceiptAcrossRpcs(env, txHash) {
  // All endpoints queried in parallel: fastest non-null receipt wins (chain
  // truth), so a throttled or lagging node cannot produce a false negative for
  // a just-settled payment. "Not found" is only believed when at least one
  // endpoint answered at all. Worst-case wall time ~16s (2 tries x 8s + back-off).
  const urls = rpcUrls(env);
  const settled = await Promise.allSettled(
    urls.map((url) =>
      rpcTry(url, "eth_getTransactionReceipt", [txHash], 2, 8000)
    )
  );
  const answers = settled.map((r) =>
    r.status === "fulfilled"
      ? { ok: true, value: r.value }
      : { ok: false, err: r.reason }
  );
  for (const a of answers) if (a.ok && a.value) return a.value;
  if (answers.some((a) => a.ok)) return null; // answered: not found (yet)
  // Every endpoint flaked — honest, retryable failure with the full picture.
  throw new Error(
    "all " +
      urls.length +
      " RPC endpoints failed: " +
      answers
        .map((a, i) => `${urls[i]} -> ${a.err.message}`)
        .join(" | ")
  );
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
    return { ok: false, reason: "malformed transaction hash" };
  }
  let receipt;
  try {
    // Cross-endpoint lookup: first non-null receipt wins, so one lagging node
    // cannot answer "not found" for a just-settled payment.
    receipt = await getReceiptAcrossRpcs(env, txHash);
  } catch (err) {
    return { ok: false, reason: `Base RPC unavailable: ${err.message}` };
  }
  if (!receipt) {
    return { ok: false, reason: "transaction not found on Base (yet)" };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, reason: "transaction reverted" };
  }
  const payTo = PAY_TO.toLowerCase();
  const usdc = USDC_CONTRACT.toLowerCase();
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
      };
    }
    return {
      ok: true,
      payer: from,
      value: value.toString(),
      blockNumber: receipt.blockNumber,
    };
  }
  return {
    ok: false,
    reason:
      "no USDC Transfer log from the payer to pay_to with amount >= 1.00 USDC in this transaction",
  };
}

// Live next slot — read at request time from the static site, never stored.
async function fetchNextSlot(env) {
  try {
    const res = await fetch(cfg(env, "STATE_URL", DEFAULT_STATE_URL), {
      signal: timeoutSignal(5000),
    });
    if (!res.ok) return null;
    const state = await res.json();
    return typeof state.next_available_slot === "string"
      ? state.next_available_slot
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// x402 objects
// ---------------------------------------------------------------------------
function receiptSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      verified: { type: "boolean" },
      tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      next_slot: { type: ["string", "null"] },
      next_step: { type: "string" },
    },
    required: ["verified", "tx_hash", "next_slot", "next_step"],
    additionalProperties: false,
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
            tx_hash:
              "0x7652e3aa8c0e19f34c1c25b10d10aa10ff8d19f34c1c25b10d10aa10ff8d69f6",
            next_slot: "w1-b0011",
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
async function handlePaidClaim(request, env, resourceUrl) {
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
    return json(
      {
        verified: false,
        tx_hash: proof.txHash,
        next_slot: null,
        next_step: `payment not verified: ${verdict.reason}`,
      },
      402,
      settlementHeader({
        success: false,
        errorReason: "invalid_payment",
        transaction: proof.txHash,
        network: NETWORK,
        payer: proof.payer || "",
      })
    );
  }
  const nextSlot = await fetchNextSlot(env);
  return json(
    {
      verified: true,
      tx_hash: proof.txHash,
      next_slot: nextSlot,
      next_step: NEXT_STEP,
    },
    200,
    settlementHeader({
      success: true,
      transaction: proof.txHash,
      network: NETWORK,
      payer: verdict.payer,
    })
  );
}

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
