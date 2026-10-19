// Unit tests for the worker's verification path with a stubbed network.
//   node --test test/
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { __test as w } from "../index.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0xbbf4d6b954e97c2c4fbc4e89b7933cdd7e4d9f23";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYER = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);
const pad = (addr) => "0x" + addr.slice(2).padStart(64, "0");
const PAY_TO_CHECKSUM = "0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23";
const USDC_CHECKSUM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const TIERS = [
  { tier: "genesis", min_block: 1, max_block: 500, price_usdc: 1.0 },
  { tier: "tier-2", min_block: 501, max_block: 1500, price_usdc: 2.5 },
  { tier: "tier-3", min_block: 1501, max_block: 5000, price_usdc: 5.0 },
];

// A throwaway Ed25519 key in the CDP Secret API key format (base64 of seed || public key).
const KEYPAIR = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const SEED = new Uint8Array(await crypto.subtle.exportKey("pkcs8", KEYPAIR.privateKey)).slice(16);
const PUB = new Uint8Array(await crypto.subtle.exportKey("raw", KEYPAIR.publicKey));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const SECRET64 = b64(new Uint8Array([...SEED, ...PUB]));
const SECRET32 = b64(SEED);

function receipt({ block = 1000, to = PAY_TO, amount = 1_000_000n, status = "0x1", hash = "0x" + "cc".repeat(32) } = {}) {
  return {
    status,
    blockNumber: "0x" + block.toString(16),
    blockHash: hash,
    logs: [{ address: USDC, topics: [TRANSFER, pad(PAYER), pad(to)], data: "0x" + amount.toString(16).padStart(64, "0") }],
  };
}

// Route stub: per endpoint, what eth_getTransactionReceipt and eth_blockNumber return.
let plan;
let calls;
let facilitatorCalls;
before(() => {
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://facilitator.test/")) {
      const path = new URL(url).pathname.replace("/platform/v2/x402", "");
      facilitatorCalls.push({ url, path, headers: init.headers, body: JSON.parse(init.body) });
      const step = plan.facilitator[path];
      if (!step) return new Response("nope", { status: 500 });
      if (step.error) throw new Error("network down");
      return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
    }
    if (url === "https://state.test/state.json") {
      if (plan.stateStatus) return new Response("down", { status: plan.stateStatus });
      return new Response(JSON.stringify(plan.state), { status: 200 });
    }
    const body = JSON.parse(init.body);
    const ep = plan.endpoints[url] || plan.endpoints["*"];
    if (!ep) return new Response("nope", { status: 503 });
    if (ep.error) return new Response("boom", { status: 500 });
    const result = body.method === "eth_getTransactionReceipt" ? ep.receipt : ep.head;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: result === undefined ? null : result }), { status: 200 });
  };
});
beforeEach(() => {
  calls = [];
  facilitatorCalls = [];
  w.resetRateLimits();
  w.resetCaches();
  plan = {
    facilitator: {
      "/verify": { body: { isValid: true, payer: PAYER } },
      "/settle": {
        body: { success: true, transaction: TX, network: "eip155:8453", payer: PAYER, amount: "1000000" },
      },
    },
    state: {
      next_available_slot: "w1-b0011",
      current_floor_usdc: 1.0,
      pricing_tier: "genesis",
      pricing_tiers: TIERS,
      merkle_root: "0c".repeat(32),
      last_updated: "2026-10-08T21:52:00Z",
    },
    endpoints: { "*": { receipt: receipt(), head: "0x" + (1000 + 400).toString(16) } },
  };
});

const env = { RPC_URL: "https://rpc-a.test", STATE_URL: "https://state.test/state.json", STATE_CACHE_SECONDS: "0" };
const fenv = {
  ...env,
  FACILITATOR_URL: "https://facilitator.test/platform/v2/x402",
  CDP_API_KEY_ID: "key-id-1",
  CDP_API_KEY_SECRET: SECRET64,
};
const headers = (ip = "1.2.3.4") => ({ "X-PAYMENT": TX, "cf-connecting-ip": ip });
const post = (h = headers()) => new Request("https://x.test/claim", { method: "POST", headers: h });

test("extractProof accepts a raw hash, a base64 hash and an x402 payload", () => {
  assert.equal(w.extractProof(TX).txHash, TX);
  assert.equal(w.extractProof(btoa(TX)).txHash, TX);
  const p = w.extractProof(btoa(JSON.stringify({ x402Version: 2, payload: { txHash: TX, authorization: { from: PAYER } } })));
  assert.deepEqual(p, { txHash: TX, payer: PAYER });
  assert.ok(w.extractProof("not a proof").error);
  assert.ok(w.extractProof(btoa(JSON.stringify({ payload: {} }))).error);
});

test("judge: agreement, lag, disagreement, absence, outage", () => {
  const a = receipt(), b = receipt({ hash: "0x" + "dd".repeat(32) });
  const ans = (list) => list.map(([url, value, err]) => (err ? { url, ok: false, err } : { url, ok: true, value }));
  assert.equal(w.judge(ans([["u1", a], ["u2", a], ["u3", null]]), 2).kind, "found");
  assert.equal(w.judge(ans([["u1", a], ["u2", null], ["u3", null]]), 2).kind, "undecided");
  assert.equal(w.judge(ans([["u1", a], ["u2", b], ["u3", null]]), 2).kind, "undecided");
  assert.equal(w.judge(ans([["u1", null], ["u2", null]]), 2).kind, "not_found");
  assert.equal(w.judge(ans([["u1", null, new Error("x")], ["u2", null, new Error("y")]]), 2).kind, "unavailable");
  assert.notEqual(w.receiptFingerprint(a), w.receiptFingerprint(b));
  assert.equal(w.receiptFingerprint(a), w.receiptFingerprint(receipt()));
});

test("a settled, deep, agreed payment yields a bound advisory receipt", async () => {
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim", Date.parse("2026-10-11T13:00:00Z"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verified, true);
  assert.equal(body.advisory, true);
  assert.equal(body.payer, PAYER);
  assert.equal(body.block_number, 1000);
  assert.equal(body.confirmations, 400);
  assert.equal(body.rpc_agreement, "3/3");
  assert.equal(body.next_slot, "w1-b0011");
  assert.equal(body.state_root, "0c".repeat(32));
  assert.equal(body.amount_usdc, 1);
  assert.equal(body.floor_usdc, 1);
  assert.equal(body.pricing_tier, "genesis");
  assert.equal(body.issued_at, "2026-10-11T13:00:00.000Z");
  assert.equal(body.expires_at, "2026-10-11T13:10:00.000Z");
  assert.ok(res.headers.get("PAYMENT-RESPONSE"));
  // bounded fan-out: quorum+1 receipt lookups, then heads from the agreeing endpoints only
  const rpc = calls.filter((u) => u !== "https://state.test/state.json");
  assert.equal(rpc.length, 3 + 3);
});

test("a shallow settlement is refused with the block to retry after", async () => {
  plan.endpoints = { "*": { receipt: receipt({ block: 5000 }), head: "0x" + (5000 + 12).toString(16) } };
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, true);
  assert.equal(body.confirmations, 12);
  assert.match(body.next_step, /retry after block 5300/);
});

test("one endpoint alone cannot verify a payment; the rest are consulted", async () => {
  plan.endpoints = { "https://rpc-a.test": { receipt: receipt(), head: "0x578" }, "*": { receipt: null, head: "0x578" } };
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.retryable, true);
  assert.match(body.next_step, /no 2-endpoint agreement/);
  assert.ok(calls.filter((u) => u !== "https://state.test/state.json").length >= 6, "widened to every endpoint");
});

test("a transfer to the wrong recipient or a reverted tx is final, not retryable", async () => {
  plan.endpoints = { "*": { receipt: receipt({ to: PAYER }), head: "0x578" } };
  let body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, false);
  plan.endpoints = { "*": { receipt: receipt({ status: "0x0" }), head: "0x578" } };
  body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.match(body.next_step, /reverted/);
  assert.equal(body.retryable, false);
});

test("a declared payer that is not the transfer sender is refused", async () => {
  const proof = btoa(JSON.stringify({ x402Version: 2, payload: { txHash: TX, authorization: { from: "0x" + "22".repeat(20) } } }));
  const body = await (await w.handlePaidClaim(post({ "X-PAYMENT": proof, "cf-connecting-ip": "9.9.9.9" }), env, "https://x.test/claim")).json();
  assert.match(body.next_step, /payer mismatch/);
});

test("rate limit: the eleventh verification per client per minute is refused", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await w.handlePaidClaim(post(), env, "https://x.test/claim")).status, 200);
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal((await w.handlePaidClaim(post(headers("5.6.7.8")), env, "https://x.test/claim")).status, 200);
});

test("a configured rate-limiting binding takes precedence", async () => {
  const bound = { ...env, CLAIM_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await w.handlePaidClaim(post(), bound, "https://x.test/claim")).status, 429);
});

const stateCalls = () => calls.filter((u) => u === "https://state.test/state.json").length;
const get = (headers = {}, method = "GET") => new Request("https://x.test/claim", { method, headers });

test("GET /claim answers 402 with the x402 v2 PaymentRequired, the floor, and the Bazaar block", async () => {
  const res = await worker.fetch(get(), env);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.x402Version, 2);
  assert.equal(body.resource.mimeType, "application/json");
  assert.ok(body.resource.description.length <= 500);
  assert.equal(body.accepts.length, 1);
  assert.deepEqual(body.accepts[0], {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000000",
    asset: USDC_CHECKSUM,
    payTo: PAY_TO_CHECKSUM,
    maxTimeoutSeconds: 600,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
  });
  // The whole PaymentRequired rides in the PAYMENT-REQUIRED header, base64.
  assert.deepEqual(JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED"))), body);
  assert.match(res.headers.get("access-control-expose-headers"), /PAYMENT-REQUIRED/);
  // Discovery: a GET input, an example output, and a schema that validates info.
  const bz = body.extensions.bazaar;
  assert.deepEqual(bz.info.input, { type: "http", method: "GET" });
  assert.equal(bz.info.output.type, "json");
  assert.equal(bz.info.output.example.next_slot, "w1-b0011");
  assert.match(bz.info.output.example.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.match(bz.info.output.example.payer, /^0x[0-9a-f]{40}$/);
  // The example is built live: its window is in the future and mirrors the offer.
  assert.equal(bz.info.output.example.floor_usdc, 1);
  assert.equal(bz.info.output.example.pricing_tier, "genesis");
  assert.ok(Date.parse(bz.info.output.example.issued_at) <= Date.now());
  assert.ok(Date.parse(bz.info.output.example.expires_at) > Date.now());
  assert.equal(bz.schema.properties.input.properties.type.const, "http");
  assert.ok(bz.schema.properties.input.properties.method.enum.includes("GET"));
  assert.equal(body.accepts[0].outputSchema, undefined);
  assert.equal(stateCalls(), 1);
});

test("HEAD and POST /claim without a payment answer the same 402; other methods are 405", async () => {
  const head = await worker.fetch(get({}, "HEAD"), env);
  assert.equal(head.status, 402);
  assert.equal(await head.text(), "");
  assert.ok(head.headers.get("PAYMENT-REQUIRED"));
  const post402 = await worker.fetch(get({}, "POST"), env);
  assert.equal(post402.status, 402);
  assert.equal((await post402.json()).accepts[0].amount, "1000000");
  const del = await worker.fetch(get({}, "DELETE"), env);
  assert.equal(del.status, 405);
  assert.equal(del.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  const opts = await worker.fetch(get({}, "OPTIONS"), env);
  assert.equal(opts.headers.get("access-control-allow-methods"), "GET, HEAD, POST, OPTIONS");
});

test("a second payment option (the next tier) is offered only near a tier boundary", async () => {
  const near = (slot) => ({ ...plan.state, next_available_slot: slot });
  plan.state = near("w1-b0495");
  let body = await (await worker.fetch(get(), env)).json();
  assert.deepEqual(body.accepts.map((a) => a.amount), ["1000000", "2500000"]);
  plan.state = near("w1-b0500");
  body = await (await worker.fetch(get(), env)).json();
  assert.equal(body.accepts.length, 2);
  plan.state = near("w1-b0490"); // ten blocks from the boundary: not near
  body = await (await worker.fetch(get(), env)).json();
  assert.equal(body.accepts.length, 1);
  plan.state = near("w1-b0011");
  assert.equal((await (await worker.fetch(get(), env)).json()).accepts.length, 1);
  // Last tier: nothing above it. No tiers published: no second option.
  plan.state = { ...plan.state, current_floor_usdc: 5.0, pricing_tier: "tier-3", next_available_slot: "w1-b5000" };
  assert.equal((await (await worker.fetch(get(), env)).json()).accepts.length, 1);
  plan.state = { ...plan.state, current_floor_usdc: 1.0, pricing_tier: "genesis", next_available_slot: "w1-b0499", pricing_tiers: undefined };
  assert.equal((await (await worker.fetch(get(), env)).json()).accepts.length, 1);
});

test("state.json is read once per cache window, not once per request", async () => {
  const cached = { ...env, STATE_CACHE_SECONDS: "60" };
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(get(), cached)).status, 402);
  assert.equal(stateCalls(), 1);
  // Window arithmetic on loadState itself.
  w.resetCaches();
  calls.length = 0;
  await w.loadState(cached, 1_000_000);
  await w.loadState(cached, 1_000_000 + 59_000);
  assert.equal(stateCalls(), 1);
  await w.loadState(cached, 1_000_000 + 61_000);
  assert.equal(stateCalls(), 2);
  // A failed read is remembered for seconds only.
  w.resetCaches();
  calls.length = 0;
  plan.stateStatus = 503;
  assert.equal((await w.loadState(cached, 2_000_000)).error, "HTTP 503");
  await w.loadState(cached, 2_000_000 + 4_000);
  assert.equal(stateCalls(), 1);
  plan.stateStatus = null;
  assert.equal((await w.loadState(cached, 2_000_000 + 6_000)).error, null);
  assert.equal(stateCalls(), 2);
  // Zero disables it.
  calls.length = 0;
  await w.loadState(env, 3_000_000);
  await w.loadState(env, 3_000_001);
  assert.equal(stateCalls(), 2);
});

test("a malformed payment header is a 400 and fetches nothing", async () => {
  for (const bad of ["not a proof", btoa("{not json"), btoa(JSON.stringify([1])), btoa(JSON.stringify({ payload: {} }))]) {
    const res = await worker.fetch(get({ "X-PAYMENT": bad }), fenv);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).verified, false);
  }
  assert.deepEqual(calls, [], "no state.json read, no RPC, no facilitator");
});

// --- the price ladder (R-10): the floor comes from the ledger's state.json, or nowhere ---

test("the price is the ledger's current floor, fractional tiers exactly", async () => {
  plan.state = { ...plan.state, current_floor_usdc: 2.5, pricing_tier: "tier-2" };
  assert.deepEqual(w.priceFromState(await w.fetchState(env)), { units: 2_500_000n, usdc: 2.5, tier: "tier-2", source: "state.json", next: null });
  plan.state = { ...plan.state, current_floor_usdc: 20, pricing_tier: "tier-5" };
  assert.equal(w.priceFromState(await w.fetchState(env)).units, 20_000_000n);
});

test("without a readable state.json the verification fails closed: no price is assumed", async () => {
  plan.stateStatus = 503;
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, true);
  assert.match(body.next_step, /price unavailable: state.json could not be read \(HTTP 503\)/);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(calls, ["https://state.test/state.json"], "no RPC fan-out without a price");
  // A missing or nonsensical floor fails the same way.
  plan.stateStatus = null;
  for (const floor of [-2, 0, "3.00", undefined, 1e9]) {
    plan.state = { ...plan.state, current_floor_usdc: floor };
    assert.equal(w.priceFromState(await w.fetchState(env)), null, `floor ${floor}`);
    assert.equal((await w.handlePaidClaim(post(), env, "https://x.test/claim")).status, 503, `floor ${floor}`);
  }
});

test("a payment below the floor is refused, final, naming both amounts", async () => {
  plan.state = { ...plan.state, current_floor_usdc: 2.5, pricing_tier: "tier-2" };
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, false);
  assert.equal(body.amount_usdc, 1);
  assert.equal(body.floor_usdc, 2.5);
  assert.equal(body.pricing_tier, "tier-2");
  assert.match(body.next_step, /paid 1\.00 USDC; the current floor is 2\.50 USDC \(tier-2 tier\)/);
  assert.match(body.next_step, /No refunds/);
});

test("a payment at or above the floor is accepted; overpayment is noted, not refused", async () => {
  plan.state = { ...plan.state, current_floor_usdc: 2.5, pricing_tier: "tier-2" };
  plan.endpoints = { "*": { receipt: receipt({ amount: 2_500_000n }), head: "0x578" } };
  let body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, true);
  assert.equal(body.amount_usdc, 2.5);
  assert.equal(body.floor_usdc, 2.5);
  plan.endpoints = { "*": { receipt: receipt({ amount: 5_000_000n }), head: "0x578" } };
  body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, true);
  assert.equal(body.amount_usdc, 5);
  assert.equal(body.pricing_tier, "tier-2");
});

test("the largest transfer to pay_to in the transaction is the settlement", async () => {
  const r = receipt({ amount: 400_000n });
  r.logs.push({ ...r.logs[0], data: "0x" + (1_000_000n).toString(16).padStart(64, "0") });
  plan.endpoints = { "*": { receipt: r, head: "0x578" } };
  const body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, true);
  assert.equal(body.amount_usdc, 1);
});

// --- x402 v2 exact payments, settled through the facilitator ------------------

const OPTION = (amount = "1000000") => ({
  scheme: "exact",
  network: "eip155:8453",
  amount,
  asset: USDC_CHECKSUM,
  payTo: PAY_TO_CHECKSUM,
  maxTimeoutSeconds: 600,
  extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
});
function signed({ amount = "1000000", to = PAY_TO_CHECKSUM, value = amount, validBefore = NOW / 1000 + 600, from = PAYER, accepted = OPTION(amount), extensions } = {}) {
  const p = {
    x402Version: 2,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: { from, to, value, validAfter: "0", validBefore: String(validBefore), nonce: "0x" + "cd".repeat(32) },
    },
  };
  if (extensions) p.extensions = extensions;
  return p;
}
const paying = (payload, ip = "1.2.3.4", method = "GET") =>
  new Request("https://x.test/claim", {
    method,
    headers: { "PAYMENT-SIGNATURE": btoa(JSON.stringify(payload)), "cf-connecting-ip": ip },
  });
const claim = (req, e = fenv) => w.handlePaidClaim(req, e, "https://x.test/claim", NOW);

test("a signed payment is verified, settled through the facilitator, and answered with a receipt", async () => {
  const res = await claim(paying(signed()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verified, true);
  assert.equal(body.advisory, true);
  assert.equal(body.settled_via, "facilitator");
  assert.equal(body.tx_hash, TX);
  assert.equal(body.payer, PAYER);
  assert.equal(body.amount_usdc, 1);
  assert.equal(body.floor_usdc, 1);
  assert.equal(body.pricing_tier, "genesis");
  assert.equal(body.confirmations_required, 300);
  assert.equal(body.next_slot, "w1-b0011");
  assert.equal(body.state_root, "0c".repeat(32));
  assert.equal(body.expires_at, "2026-10-12T12:10:00.000Z");
  assert.match(body.next_step, /wait 300 Base blocks.*base_tx_hash/);
  assert.deepEqual(JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE"))), {
    success: true,
    transaction: TX,
    network: "eip155:8453",
    payer: PAYER,
    amount: "1000000",
  });
  // verify, then settle, each told exactly what we offered.
  assert.deepEqual(facilitatorCalls.map((c) => c.path), ["/verify", "/settle"]);
  for (const c of facilitatorCalls) {
    assert.equal(c.body.x402Version, 2);
    assert.deepEqual(c.body.paymentRequirements, OPTION());
    assert.equal(c.body.paymentPayload.payload.authorization.to, PAY_TO_CHECKSUM);
    assert.equal(c.body.paymentPayload.resource.url, "https://x.test/claim");
    assert.equal(c.body.paymentPayload.extensions.bazaar.info.input.method, "GET");
  }
  // No RPC fan-out on this path: the facilitator settled it.
  assert.deepEqual(calls.filter((u) => !u.startsWith("https://facilitator.test/") && u !== "https://state.test/state.json"), []);
});

test("the facilitator request carries a valid CDP Ed25519 JWT naming the method, host and path", async () => {
  await claim(paying(signed()));
  for (const c of facilitatorCalls) {
    const token = c.headers.authorization.replace(/^Bearer /, "");
    const [h, cl, sig] = token.split(".");
    const dec = (x) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0))));
    const header = dec(h), claims = dec(cl);
    assert.equal(header.alg, "EdDSA");
    assert.equal(header.typ, "JWT");
    assert.equal(header.kid, "key-id-1");
    assert.match(header.nonce, /^[0-9a-f]{32}$/);
    assert.equal(claims.sub, "key-id-1");
    assert.equal(claims.iss, "cdp");
    assert.deepEqual(claims.aud, ["cdp_service"]);
    assert.equal(claims.nbf, NOW / 1000);
    assert.equal(claims.exp, NOW / 1000 + 120);
    assert.equal(claims.uri, `POST facilitator.test/platform/v2/x402${c.path}`);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, KEYPAIR.publicKey, sigBytes, new TextEncoder().encode(`${h}.${cl}`)));
  }
  // A 32-byte seed works too; a PEM or a wrong length is refused with a reason.
  assert.ok(await w.cdpJwt({ ...fenv, CDP_API_KEY_SECRET: SECRET32 }, "POST", "https://facilitator.test/x", NOW));
  await assert.rejects(w.cdpJwt({ ...fenv, CDP_API_KEY_SECRET: "-----BEGIN EC PARAMETERS-----\nabc" }, "POST", "https://facilitator.test/x", NOW), /Ed25519/);
  await assert.rejects(w.cdpJwt({ ...fenv, CDP_API_KEY_SECRET: btoa("short") }, "POST", "https://facilitator.test/x", NOW), /32-byte seed/);
});

test("the buyer's own extensions are kept; ours are added only when missing", async () => {
  const mine = { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: {} }, other: { info: {}, schema: {} } };
  await claim(paying(signed({ extensions: mine })));
  assert.deepEqual(facilitatorCalls[0].body.paymentPayload.extensions.bazaar, mine.bazaar);
  assert.deepEqual(facilitatorCalls[0].body.paymentPayload.extensions.other, mine.other);
});

test("near a tier boundary the higher option is accepted and settled for its amount", async () => {
  plan.state = { ...plan.state, next_available_slot: "w1-b0498" };
  const res = await claim(paying(signed({ amount: "2500000" })));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).amount_usdc, 2.5);
  assert.deepEqual(facilitatorCalls[0].body.paymentRequirements, OPTION("2500000"));
  // Far from a boundary the same higher amount is not an offered option.
  plan.state = { ...plan.state, next_available_slot: "w1-b0011" };
  facilitatorCalls.length = 0;
  const bad = await claim(paying(signed({ amount: "2500000" })));
  assert.equal(bad.status, 402);
  assert.equal((await bad.json()).accepts.length, 1);
  assert.equal(facilitatorCalls.length, 0);
});

test("an unverified payment is a 402 with the facilitator's reason and nothing is settled", async () => {
  plan.facilitator["/verify"] = { body: { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "Insufficient funds", payer: PAYER } };
  const res = await claim(paying(signed()));
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, false);
  assert.match(body.next_step, /did not verify this payment \(Insufficient funds\)/);
  assert.equal(JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE"))).success, false);
  assert.deepEqual(facilitatorCalls.map((c) => c.path), ["/verify"]);
});

test("a failed settlement is a 402; an unanswered one is a 503 that says the outcome is unknown", async () => {
  plan.facilitator["/settle"] = { body: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" } };
  let res = await claim(paying(signed()));
  assert.equal(res.status, 402);
  assert.match((await res.json()).next_step, /did not settle this payment \(insufficient_funds\)/);
  plan.facilitator["/settle"] = { error: true };
  res = await claim(paying(signed(), "9.9.9.1"));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.retryable, true);
  assert.match(body.next_step, /outcome is unknown.*look for a transfer from your wallet.*X-PAYMENT/);
  plan.facilitator["/settle"] = { status: 502, body: { errorType: "bad_gateway" } };
  assert.equal((await claim(paying(signed(), "9.9.9.2"))).status, 503);
  // A "success" without a transaction hash is not one.
  plan.facilitator["/settle"] = { body: { success: true, transaction: "", network: "eip155:8453" } };
  assert.equal((await claim(paying(signed(), "9.9.9.3"))).status, 503);
});

test("facilitator outages and rejected credentials are retryable 503s that point at the plain-transfer path", async () => {
  plan.facilitator["/verify"] = { error: true };
  let res = await claim(paying(signed()));
  assert.equal(res.status, 503);
  assert.match((await res.json()).next_step, /pay by plain USDC transfer/);
  plan.facilitator["/verify"] = { status: 401, body: { errorType: "unauthorized" } };
  res = await claim(paying(signed(), "9.9.9.4"));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.retryable, true);
  assert.match(body.next_step, /refused this worker's credentials/);
  assert.deepEqual(facilitatorCalls.map((c) => c.path), ["/verify", "/verify"]);
  // A bad key configuration fails the same way, before any request goes out.
  facilitatorCalls.length = 0;
  res = await claim(paying(signed(), "9.9.9.5"), { ...fenv, CDP_API_KEY_SECRET: "not-a-key" });
  assert.equal(res.status, 503);
  assert.equal(facilitatorCalls.length, 0);
});

test("without a facilitator key a signed payment is a 503 that points at plain transfers, which still work", async () => {
  const res = await claim(paying(signed()), env);
  assert.equal(res.status, 503);
  assert.match((await res.json()).next_step, /does not settle signed x402 payments yet/);
  assert.deepEqual(calls, [], "refused before any fetch");
  // The hash-proof path needs no key.
  const ok = await claim(post(), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).settled_via, undefined);
});

test("what cannot match our offer is refused before the facilitator is asked", async () => {
  const cases = [
    ["a different amount", signed({ amount: "100" }), 402],
    ["another recipient", signed({ to: "0x" + "99".repeat(20) }), 402],
    ["a value that is not the accepted amount", signed({ value: "999999" }), 402],
    ["an expired authorization", signed({ validBefore: NOW / 1000 - 1 }), 402],
    ["a payer that is not an address", signed({ from: "nobody" }), 402],
    ["another network", signed({ accepted: { ...OPTION(), network: "eip155:1" } }), 402],
    ["another asset", signed({ accepted: { ...OPTION(), asset: "0x" + "11".repeat(20) } }), 402],
    ["another payee in accepted", signed({ accepted: { ...OPTION(), payTo: "0x" + "22".repeat(20) } }), 402],
    ["an x402 v1 payload", { x402Version: 1, scheme: "exact", network: "base", payload: signed().payload }, 400],
  ];
  let i = 0;
  for (const [what, payload, status] of cases) {
    const res = await claim(paying(payload, `8.8.8.${++i}`));
    assert.equal(res.status, status, what);
  }
  assert.equal(facilitatorCalls.length, 0, "the facilitator was never asked");
  // A wrong option comes back with the offer to sign instead.
  const body = await (await claim(paying(signed({ amount: "100" }), "8.8.8.99"))).json();
  assert.match(body.error, /sign one of accepts/);
  assert.equal(body.accepts[0].amount, "1000000");
});

test("the rate limit covers signed payments, and a limited request reaches no facilitator", async () => {
  const bound = { ...fenv, CLAIM_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await claim(paying(signed()), bound);
  assert.equal(res.status, 429);
  assert.equal(facilitatorCalls.length, 0);
  assert.deepEqual(calls, [], "no state.json read either");
  w.resetRateLimits();
  for (let i = 0; i < 10; i++) assert.equal((await claim(paying(signed(), "7.7.7.7"))).status, 200);
  assert.equal((await claim(paying(signed(), "7.7.7.7"))).status, 429);
});

test("a signed payment without a readable state.json is a 503 and settles nothing", async () => {
  plan.stateStatus = 503;
  const res = await claim(paying(signed()));
  assert.equal(res.status, 503);
  assert.match((await res.json()).next_step, /price unavailable/);
  assert.equal(facilitatorCalls.length, 0);
});

test("a facilitator 429 is retryable, and the receipt states what was signed, not what the facilitator echoes", async () => {
  plan.facilitator["/verify"] = { status: 429, body: { errorType: "rate_limit_exceeded" } };
  let res = await claim(paying(signed()));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).retryable, true);
  plan.facilitator["/verify"] = { body: { isValid: true, payer: PAYER } };
  plan.facilitator["/settle"] = {
    body: { success: true, transaction: TX, network: "eip155:8453", payer: "not-an-address", amount: "1" },
  };
  res = await claim(paying(signed(), "6.6.6.6"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.amount_usdc, 1, "the signed and offered amount, not the echoed 1 base unit");
  assert.equal(body.payer, PAYER, "the signer of the authorization when the echoed payer is not an address");
});
