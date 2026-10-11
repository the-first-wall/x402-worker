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
before(() => {
  globalThis.fetch = async (url, init) => {
    calls.push(url);
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
  w.resetRateLimits();
  plan = {
    state: {
      next_available_slot: "w1-b0011",
      current_floor_usdc: 1.0,
      pricing_tier: "genesis",
      merkle_root: "0c".repeat(32),
      last_updated: "2026-10-08T21:52:00Z",
    },
    endpoints: { "*": { receipt: receipt(), head: "0x" + (1000 + 400).toString(16) } },
  };
});

const env = { RPC_URL: "https://rpc-a.test", STATE_URL: "https://state.test/state.json" };
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

test("GET /claim still answers 402 with the advisory receipt schema", async () => {
  const res = await worker.fetch(new Request("https://x.test/claim"), env);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.accepts[0].outputSchema.properties.advisory.const, true);
  assert.equal(body.accepts[0].amount, "1000000");
  assert.equal(body.extensions.bazaar.info.price.tier, "genesis");
  assert.ok(res.headers.get("PAYMENT-REQUIRED"));
});

// --- the price ladder (R-10): the floor comes from the ledger's state.json ---

test("GET /claim asks for the ledger's current floor, not a constant", async () => {
  plan.state = { ...plan.state, next_available_slot: "w1-b0501", current_floor_usdc: 3.0, pricing_tier: "tier-2" };
  const body = await (await worker.fetch(new Request("https://x.test/claim"), env)).json();
  assert.equal(body.accepts[0].amount, "3000000");
  assert.equal(body.accepts[0].maxAmountRequired, "3000000");
  assert.deepEqual(
    { usdc: body.extensions.bazaar.info.price.usdc, tier: body.extensions.bazaar.info.price.tier },
    { usdc: 3, tier: "tier-2" }
  );
  assert.match(body.extensions.bazaar.info.price.rule, /no refunds/);
  // Fractional tiers survive the base-unit conversion exactly.
  plan.state = { ...plan.state, current_floor_usdc: 7.5, pricing_tier: "tier-3" };
  assert.equal((await (await worker.fetch(new Request("https://x.test/claim"), env)).json()).accepts[0].amount, "7500000");
});

test("without state.json the genesis floor is assumed, never more", async () => {
  plan.stateStatus = 503;
  const body = await (await worker.fetch(new Request("https://x.test/claim"), env)).json();
  assert.equal(body.accepts[0].amount, "1000000");
  assert.match(body.extensions.bazaar.info.price.source, /unavailable/);
  // A nonsensical floor is ignored the same way.
  plan.stateStatus = null;
  plan.state = { ...plan.state, current_floor_usdc: -2 };
  assert.equal(w.priceFromState(await w.fetchState(env)).source, "fallback");
  plan.state = { ...plan.state, current_floor_usdc: "3.00" };
  assert.equal(w.priceFromState(await w.fetchState(env)).source, "fallback");
});

test("a payment below the floor is refused, final, naming both amounts", async () => {
  plan.state = { ...plan.state, current_floor_usdc: 3.0, pricing_tier: "tier-2" };
  const res = await w.handlePaidClaim(post(), env, "https://x.test/claim");
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.equal(body.retryable, false);
  assert.equal(body.amount_usdc, 1);
  assert.equal(body.floor_usdc, 3);
  assert.equal(body.pricing_tier, "tier-2");
  assert.match(body.next_step, /paid 1\.00 USDC; the current floor is 3\.00 USDC \(tier-2 tier\)/);
  assert.match(body.next_step, /No refunds/);
});

test("a payment at or above the floor is accepted; overpayment is noted, not refused", async () => {
  plan.state = { ...plan.state, current_floor_usdc: 3.0, pricing_tier: "tier-2" };
  plan.endpoints = { "*": { receipt: receipt({ amount: 3_000_000n }), head: "0x578" } };
  let body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, true);
  assert.equal(body.amount_usdc, 3);
  assert.equal(body.floor_usdc, 3);
  plan.endpoints = { "*": { receipt: receipt({ amount: 7_500_000n }), head: "0x578" } };
  body = await (await w.handlePaidClaim(post(), env, "https://x.test/claim")).json();
  assert.equal(body.verified, true);
  assert.equal(body.amount_usdc, 7.5);
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
