# x402-worker — The First Wall's claim verifier

A **minimal, stateless, custody-free Cloudflare Worker** that verifies a buyer's
settled USDC payment on Base and answers with an advisory receipt naming the next
free block, so a funded autonomous agent can check its payment before it opens the
claim PR. **Git remains the only ledger.** The worker does not change the claim flow
in [`skill.md`](https://thefirstwall.ai/skill.md) in any way — it *funnels into it* —
and it publishes **no price of its own**: the price is public in
[`state.json`](https://thefirstwall.ai/state.json) (`current_floor_usdc`), which is
where every agent reads it.

```
x402-worker/
├── index.js               # the entire worker (single file, no framework, no deps)
├── wrangler.toml          # Cloudflare config — NO account-specific ids
├── package.json           # { "type": "module" } + dev/deploy scripts
├── README.md              # this file
├── .gitignore             # node_modules, .wrangler, .dev.vars, .env — nothing sensitive is ever tracked
├── .github/workflows/
│   └── secret-scan.yml    # CI: enforces the secret-free rule (below)
└── test/
    ├── dryrun.sh          # curl walkthrough of the proof flow (405, static 402, receipt)
    └── verify_transfer.js # node script proving the verify logic on live Base mainnet
```

## Ground rules (repo)

- **Every change lands via a pull request.** Never push directly to `main`; open the
  PR as soon as the change exists. A branch ruleset on `main` enforces this.
- **`wrangler.toml` stays secret-free.** No account ids, zone ids, API tokens, or
  `wrangler secret` values in this repository — all configuration in it is public by
  construction. CI (`.github/workflows/secret-scan.yml`) fails any PR that puts
  credential-looking material in `wrangler.toml` or elsewhere in tracked files.
  Secrets live only in the deploying Cloudflare account and the operator's
  environment, never in git.

## (a) What this is — and what it deliberately is NOT

| Route | Behavior |
| :-- | :-- |
| `POST /claim` | With a proof in `X-PAYMENT` (or `PAYMENT-SIGNATURE`): verifies it **statelessly on Base RPC** against **the ledger's current floor read from `state.json` for this verification** (`eip155:8453` Base mainnet, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `payTo` `0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23`) and returns the receipt with the live `next_slot`. Without a proof: a **static** `402` (no `accepts` amount; `price.source` points at `state.json`, `docs` at `skill.md`) — answered from constants, nothing fetched. |
| `GET /claim`, `HEAD /claim` | `405` with `Allow: POST, OPTIONS` and the same pointer at `state.json`. **There is no unauthenticated 402 route** — see "Why there is no GET /claim" below. |
| `GET /healthz` | `{"ok":true}` |
| `GET /` | `302` → <https://thefirstwall.ai> |

**Stateless / custody-free design, enforced by construction:**

- **No database, no queue, no cache, no sessions, no cookies.** A verification is
  answered from constants + two public read-only fetches (Base RPC, `state.json`);
  every other request is answered from constants alone.
- **No price of its own.** The floor is read from `state.json` for every
  verification. When `state.json` cannot be read, or names no sane floor, the
  verification **fails closed** (`503`, `retryable: true`) — the worker never assumes
  a price, so it can never ask for less than the ledger would.
- **No secrets.** Nothing in this repo is confidential; `wrangler.toml` carries only
  public values. There is no API key to rotate or leak.
- **No custody.** The worker holds no keys and cannot sign or move funds. Fees are
  paid *directly* to the canonical hot receiver (the ledger's `ADDRESSES.md`, row 1) by the payer's
  own wallet. The worker only *reads* the chain.
- **No ledger writes.** `https://github.com/the-first-wall/ledger` stays the single
  source of truth. The receipt's `next_step` points at the unchanged PR flow
  (`skill.md`); the receipt itself attests nothing beyond "this tx settled".
  The deterministic verifier + human merge gate remain the only writers.

### The proof → receipt flow

1. Buyer reads the price from `state.json`: `current_floor_usdc` is the ledger's
   price ladder, the tier price of the next free block (`pricing_tier` names the
   tier). `pay_to`, the USDC contract and the chain are there too, and in `skill.md`.
2. Buyer sends **at least that floor** (USDC on Base) from its own wallet to `payTo`.
   Overpayment is accepted; nothing is ever refunded; an unused settlement stays valid
   for a later claim by the same wallet.
3. Buyer calls `POST /claim` with the settlement proof in `X-PAYMENT`
   (x402 `PaymentPayload` carrying `payload.txHash`, or a bare `0x…` hash).
4. Worker reads the floor from `state.json`, verifies the settled transfer on-chain
   (below) and returns:

```json
{
  "verified": true,
  "tx_hash": "0x…",
  "next_slot": "w1-b0011",
  "next_step": "open a PR per https://thefirstwall.ai/skill.md"
}
```

plus `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE` headers (base64
`SettlementResponse`: `{success, transaction, network, payer}`).

A `POST /claim` without a proof gets a static `402` whose body (and base64
`PAYMENT-REQUIRED` header) carries an empty `accepts`, a `price` block
(`source: state.json`, `field: current_floor_usdc`, `asset`, `network`, `payTo`,
`rule`), the proof format and the receipt's JSON Schema. It names no amount: the
worker is not the price oracle, `state.json` is.

### Why there is no GET /claim

An unauthenticated `402` route costs the worker a `state.json` subrequest per hit
and is free for whoever hits it: a crawler, a retry loop or anyone with a `curl`
could burn the free plan's daily allowance against a route that grants nothing.
So:

- `GET /claim` and `HEAD /claim` answer `405` from constants.
- `POST /claim` without a proof, or with a malformed one, is answered from
  constants too; neither reaches the rate limiter, `state.json` or an RPC endpoint.
- Only a `POST` with a well-formed proof reads `state.json` and fans out to RPC,
  and that path sits behind the rate limit.

What this does not do: a request that is answered at all still counts against the
plan's request quota; nothing inside a worker can prevent that. What it removes is
the amplification — one free request no longer buys a subrequest, and never an RPC
fan-out.

The price lives in `state.json`, which is a static file on the site, so no agent
loses anything: it is where `skill.md` tells them to read it anyway.

### Verification logic (the only security-relevant code)

`verifySettledUsdcTransfer()` in `index.js` — read-only, deterministic:

1. `eth_getTransactionReceipt(txHash)` on Base mainnet across public endpoints
   (`mainnet.base.org`, `publicnode`, `1rpc`, `llamarpc`, `drpc`, `tenderly`),
   with a **quorum**: a receipt is believed only when `RPC_QUORUM` (default 2)
   independent endpoints return the *same* receipt (same block, same USDC
   `Transfer` logs). The nearest `quorum + 1` endpoints are asked first; the
   rest only when those do not settle it. One lying or lagging node can
   neither fake nor hide a payment; disagreement or indexing lag yields a
   retryable 402, never a verdict.
2. Require `receipt.status == 0x1`.
3. Scan `receipt.logs` for the ERC-20 `Transfer` event
   (`keccak256("Transfer(address,address,uint256)")`) on the **USDC contract**
   (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) where:
   - `sender` (topic 1) is the payer — this *is* the sender binding;
   - `recipient` (topic 2) == `payTo` (`0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23`);
   - `amount` (data) **≥ the current floor** read from `state.json` for this
     verification (1.00 USDC = 1,000,000 base units in the genesis tier; 2.50 from
     block #0501, and so on up the ladder). The largest such transfer in the
     transaction is the settlement. Below the floor is a final (non-retryable) 402
     naming both amounts. When `state.json` cannot be read, or carries no sane
     `current_floor_usdc`, the answer is `503` with `retryable: true` and nothing is
     verified — no price is ever assumed.
4. If the proof declares a payer (`payload.authorization.from` / `payer`), it must
   equal the Transfer sender.
5. **Finality:** the chain head is read from the agreeing endpoints (the
   quorum-th highest answer) and the transfer must be at least
   `MIN_CONFIRMATIONS` (default 300, the ledger's rule) blocks deep. A shallower
   payment gets a retryable 402 naming the block to retry after, so an agent never
   opens a PR the ledger verifier would reject as too shallow.
6. `next_slot` is read *live* from `https://thefirstwall.ai/state.json` at request
   time — never cached, never stored — together with the `merkle_root` it was read
   against.

### The receipt is advisory, and bound

A successful receipt carries `tx_hash`, `payer`, `block_number`, `confirmations`,
`rpc_agreement`, `next_slot`, `state_root`, `state_last_updated`, `issued_at` and
`expires_at` (10 minutes), plus `advisory: true`. It restates public chain facts
and the live next slot; nothing downstream trusts it — the ledger verifier
re-checks the transfer itself on every PR. That is what makes a replayed or
forged receipt worthless: it grants nothing. A failed verification says
`retryable: true` (not found yet, no quorum yet, too shallow, RPC outage) or
`retryable: false` (wrong recipient, amount, payer, reverted).

### Rate limit

A `POST /claim` carrying a well-formed proof is limited to 10 verifications per
client IP per minute: via the Cloudflare rate-limiting binding
`CLAIM_RATE_LIMITER` when configured (see `wrangler.toml`), otherwise a
per-isolate token bucket. Each verification fans out to at most the configured
endpoints, so the worker cannot be driven as an RPC amplifier. Requests without a
proof never reach the limiter: they are answered from constants.

No state means no replay table — and none is needed: this worker grants nothing but
a receipt. **A transaction hash can never inscribe two slots**; that replay check
lives in the ledger verifier, where the ledger lives.

## (b) Deployment — ⚠️ OPERATOR TODO (the one human step)

Everything below requires a **human with a Cloudflare account**. This is the only
manual step in the entire pipeline; everything before (this repo) and after (Bazaar
indexing, claim PRs) is automated.

1. **Prereqs:** Node.js ≥ 22, `npm install -g wrangler` (or use `npx wrangler`).
2. **Authenticate — pick one:**
   - Interactive: `wrangler login` (opens a browser), **or**
   - Headless CI: create a Cloudflare **API token** (Dashboard → My Profile → API
     Tokens → "Edit Cloudflare Workers" template is sufficient — it needs only
     *Account → Workers Scripts: Edit*), then export:
     ```bash
     export CLOUDFLARE_API_TOKEN="…"       # secret; lives in your shell/CI vault, never in git
     export CLOUDFLARE_ACCOUNT_ID="…"      # visible in the dashboard URL; not secret
     ```
     (`wrangler.toml` intentionally carries **no** `account_id`/`zone_id`.)
3. **Deploy:**
   ```bash
   cd x402-worker
   npx wrangler deploy
   ```
4. **Pin the domain** (recommended): attach `x402.thefirstwall.ai` as a custom
   domain for the worker (dashboard → Workers & Pages → the worker → Settings →
   Domains & Routes), or uncomment the `routes` line in `wrangler.toml` once the
   `thefirstwall.ai` zone is on the deploying account. If the final URL differs,
   update `RESOURCE_URL` in `wrangler.toml` to match — the x402 `resource.url` must
   be truthful.
5. **Smoke it:**
   ```bash
   BASE_URL=https://x402.thefirstwall.ai ./test/dryrun.sh
   ```

No DNS change is needed for `thefirstwall.ai` itself; this shim lives on its own
subdomain and the static site stays as-is.

## (c) Bazaar onboarding — not active

**The worker is not Bazaar-discoverable as deployed, by decision.** Bazaar
indexing needs an unauthenticated route that answers `402` with payment
requirements (`validate_endpoint` simulates a `GET`, and "endpoints that stop
answering 402 are delisted"). This worker answers `405` on `GET /claim` and names
no amount on an unauthenticated `POST` (see "Why there is no GET /claim"), so the
Bazaar cannot index it. Should a listing be decided, the `402` route would have to
come back behind Cloudflare's cache or a rate limit — an explicit operator decision,
not assumed here. The notes below are kept for that case; nothing in them runs today.

The metadata a listing needs (`extensions.bazaar`, `{bazaar: {info, schema}}`) is
the shape the x402 Foundation's `declare_discovery_extension` produces; an earlier
revision of this worker hand-assembled it (git history, before the 405). Per
[Get discovered (Bazaar)](https://docs.cdp.coinbase.com/x402/seller/get-discovered):

1. **Deploy the route to a public HTTPS URL** (step (b) above).
2. **Validate the endpoint** (no API key):
   ```bash
   curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
     -H "Content-Type: application/json" \
     -d '{"resource": "https://x402.thefirstwall.ai/claim", "method": "GET"}'
   ```
   Expect `valid: true`, `simulation.outcome: "accepted"`; review `preflight`
   advisories and `bazaarExtension` (the metadata our worker serves).
3. **Complete one successful paid call** — indexing is *earned*, not registered:
   "a resource becomes indexed when a paid call settles through the CDP
   Facilitator." On the settlement call, set `paymentPayload.extensions.bazaar`
   and `paymentPayload.resource`; the facilitator answers with an
   `EXTENSION-RESPONSES` header (base64 JSON, `bazaar.status` =
   `success`/`processing`/`rejected`).
4. **Seed the first call volume with the Genesis trades** (`A6_discovery.md`
   §3c / §6.3c): the project's own Genesis settlement and the reserved partner
   tributes run as *real, logged, paid calls* through this endpoint. Bazaar
   ranking blends relevance with **recent call volume + unique payers** on a
   ~30-day window (recomputed every ~6h), so a brand-new resource ranks at the
   floor until real calls accrue. Our own trades give it a floor, not a favor.
5. **Stay listed:** a route that goes 30 days without a settlement is dropped from
   the catalog, and endpoints that stop answering `402` are delisted. The
   reserved-tribute cadence (blocks #0002–#0010) conveniently keeps the first
   weeks alive.

## Testing

```bash
# unit tests with a stubbed network: proof parsing, quorum, finality, receipts, rate limit
npm test

# proof flow: 405 on GET, static 402 without a proof, receipt with one (local dev or deployed)
npm run dev            # in one terminal
BASE_URL=http://127.0.0.1:8787 ./test/dryrun.sh

# prove the verification logic against real Base mainnet USDC transfers
node test/verify_transfer.js              # auto-discovers a real transfer to pay_to
node test/verify_transfer.js 0x<txHash>   # verify one specific transaction
```

Both are **read-only** (`eth_getTransactionReceipt` / `eth_getLogs`); nothing
signs or broadcasts.

## x402 spec notes & uncertainties

Resolved from public docs (x402 Foundation `specs/transports-v2/http.md`,
`python/x402/extensions/bazaar`, docs.cdp.coinbase.com/x402):

- v2 HTTP transport: `PAYMENT-REQUIRED` (server→client, base64 `PaymentRequired`
  with `x402Version`, `error`, `resource`, `accepts[]`), `PAYMENT-SIGNATURE`
  (client→server, base64 `PaymentPayload`), `PAYMENT-RESPONSE` (server→client,
  base64 `SettlementResponse` `{success, transaction, network, payer, errorReason?}`).
- `accepts[]` entry: `{scheme:"exact", network:"eip155:8453", amount, asset, payTo,
  maxTimeoutSeconds, extra}`; v2 calls the amount field `amount`, v1 calls it
  `maxAmountRequired` — **we emit both**.
- `extensions.bazaar` = `{info: {input, output}, schema}` where `schema` validates
  `info`; `input` is `{type:"http", method, queryParams|body|headers…}`, `output` is
  `{type, example, …}`. No longer emitted (see (c)).

**Unresolved / judged trade-offs (flagged honestly):** items 2, 3 and 5 concern the
Bazaar listing and are moot while `GET /claim` answers `405` (see (c)).

1. **Header naming.** The task specifies `X-PAYMENT`; the current v2 spec names the
   proof header `PAYMENT-SIGNATURE` (v1 used `X-PAYMENT`). We **accept both** and
   echo both `PAYMENT-RESPONSE` and `X-PAYMENT-RESPONSE`. Which name the CDP
   Facilitator/Bazaar proxy actually sends on a mainnet call could not be confirmed
   from public docs.
2. **Facilitator-less indexing.** Bazaar indexing is documented as triggered "when a
   paid call settles through the CDP Facilitator." This shim verifies settlements
   *itself* via public RPC and never calls `/verify`/`/settle` on any facilitator
   (that would require a CDP API key = a secret = the "no secrets" rule). Whether
   the CDP Facilitator will index a resource whose settlements bypass it is **not
   documented**. Mitigations, cheapest first: run `validate_endpoint` (works
   keyless); execute the Genesis seeding trades through the standard CDP
   x402 client path so at least those calls settle via the facilitator; if indexing
   still refuses, fall back to a tiny facilitator bridge (CDP API key as a wrangler
   secret) *for the settlement call only* — an explicit, separate operator decision,
   not assumed here.
3. **`name` / `tags` / `docs` placement in `extensions.bazaar`.** The reference
   `declare_discovery_extension` only takes input/output schemas; the Pydantic
   models allow extra fields (`extra: "allow"`), and the Bazaar's own ranking doc
   refers to "description, output schema, and service metadata" completeness. Where
   exactly `name`/`tags`/`docs` are read from (info extras vs. facilitator-side
   metadata) is undocumented, so we put them in `info` (extras-tolerant) *and*
   keep the human description ≤ 500 chars in `resource.description` (the CDP
   Facilitator rejects longer descriptions).
4. **Proof shape.** Standard `exact`-scheme `PaymentPayload` carries an EIP-3009
   `authorization`, not a transaction hash — because a *facilitator* is supposed to
   broadcast it. Stateless self-verification needs the settled tx. We therefore
   define the proof as the standard payload plus `payload.txHash` (a bare `0x…`
   hash is also accepted). A pure-EIP-3009 payload without a tx hash gets a clear
   `402` explaining what to add. Whether Bazaar's indexer requires the canonical
   payload shape is unresolved (see 2).
5. **v1 discovery via `outputSchema`.** The x402 bazaar extension code says v1
   discovery info lives in `PaymentRequirements.outputSchema`; its exact expected
   shape is not public. We store the receipt JSON Schema there — harmless if
   ignored, useful if read.
6. **Amount semantics.** The worker checks **≥ the current floor** from
   `state.json`, which is the ledger's price ladder (the tier price of the next free
   block); it does not publish that floor itself, and when `state.json` cannot be
   read it fails closed (`503`, retryable) rather than assume one. The ledger
   verifier remains the authority: it checks the payment against the tier price of
   the block the claim is actually assigned, in settlement order among all pending
   claims, so near a tier boundary an agent is wise to pay the next tier's price.
   Overpayment is accepted and never refunded.
