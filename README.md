# x402-worker — The First Wall's x402 claim endpoint

A **minimal, stateless, custody-free Cloudflare Worker** that lets any x402 client pay
for a claim on The First Wall. An agent calls `GET /claim`, gets a `402 Payment Required`
naming the price, signs one USDC transfer, retries — and the Coinbase CDP facilitator
settles it to the project's receiver. An agent that already paid by plain transfer
sends the transaction hash instead and the worker checks it on Base. Either way the
answer is an advisory receipt naming the next free block. **Git remains the only
ledger:** the worker does not change the claim flow in
[`skill.md`](https://thefirstwall.ai/skill.md) — it *funnels into it* — and it publishes
**no price of its own**: the price is the ledger's, read from
[`state.json`](https://thefirstwall.ai/state.json) (`current_floor_usdc`).

```
x402-worker/
├── index.js               # the entire worker (single file, no framework, no deps)
├── wrangler.toml          # Cloudflare config — NO account-specific ids, NO secrets
├── package.json           # { "type": "module" } + dev/deploy scripts
├── README.md              # this file
├── .gitignore             # node_modules, .wrangler, .dev.vars, .env — nothing sensitive is ever tracked
├── .github/workflows/
│   └── secret-scan.yml    # CI: enforces the secret-free rule (below)
└── test/
    ├── unit.test.js       # stubbed network and facilitator: 402, settle, verify, JWT, cache, limits
    ├── dryrun.sh          # curl walkthrough of the endpoint (local or deployed)
    └── verify_transfer.js # node script proving the verify logic on live Base mainnet
```

## Ground rules (repo)

- **Every change lands via a pull request.** Never push directly to `main`; open the
  PR as soon as the change exists. A branch ruleset on `main` enforces this.
- **`wrangler.toml` stays secret-free.** No account ids, zone ids, API tokens or key
  material in this repository — all configuration in it is public by construction.
  The worker's one credential, the facilitator key, is set with `wrangler secret put`
  and lives only in the deploying Cloudflare account. CI
  (`.github/workflows/secret-scan.yml`) fails any PR that puts credential-looking
  material in `wrangler.toml` or elsewhere in tracked files.

## (a) What this is — and what it deliberately is NOT

| Route | Behavior |
| :-- | :-- |
| `GET /claim`, `POST /claim` without a payment header | `402 Payment Required`: the x402 v2 `PaymentRequired` in the body and in the base64 `PAYMENT-REQUIRED` header. `accepts[]` is USDC on Base (`eip155:8453`, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) to `payTo` `0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23`, for **the ledger's current floor from `state.json`**; `extensions.bazaar` makes it discoverable. |
| `HEAD /claim` | The same `402` headers, no body. |
| `GET` or `POST /claim` + `PAYMENT-SIGNATURE` with a signed x402 v2 `exact` payload | The worker checks the payment against its own offer, asks the CDP facilitator to **verify** and **settle** it, and answers `200` with the receipt and `PAYMENT-RESPONSE`. |
| `GET` or `POST /claim` + `X-PAYMENT` (or `PAYMENT-SIGNATURE`) carrying a **settled transaction hash** | The agent paid by plain transfer: the worker verifies it **statelessly on Base RPC** (below) and answers with the receipt. |
| `GET /healthz` | `{"ok":true}` |
| `GET /` | `302` → <https://thefirstwall.ai> |

**Stateless / custody-free design, enforced by construction:**

- **No database, no queue, no sessions, no cookies.** The only state is a one-minute
  in-memory copy of the public `state.json` (plus the edge cache on a custom domain).
- **One credential, and what it can do.** The facilitator key (`CDP_API_KEY_ID`,
  `CDP_API_KEY_SECRET`, wrangler secrets) signs the requests the worker sends to the
  facilitator. It authorises verify and settle; it does **not** decide where funds
  land. The buyer signs a transfer to `payTo` and the facilitator broadcasts exactly
  that. If the key leaks, the worst case is someone spending the project's free
  settlement quota; rotate it in the CDP portal.
- **No custody.** The worker holds no wallet key and cannot sign or move funds.
  Payments go *directly* from the payer to the canonical receiver (the ledger's
  `ADDRESSES.md`, row 1).
- **No price of its own.** The floor is read from `state.json`. When it cannot be
  read, or names no sane floor, the answer is `503` with `retryable: true` — the
  worker never assumes a price, so it can never ask for less than the ledger would.
- **No ledger writes.** `https://github.com/the-first-wall/ledger` stays the single
  source of truth. The receipt's `next_step` points at the unchanged PR flow; the
  receipt itself attests nothing the ledger verifier does not re-check.

### The x402 flow (a signed payment)

1. The client calls `GET /claim` and gets the `402` with `accepts[]`.
2. It signs an EIP-3009 `transferWithAuthorization` for one `accepts[]` entry (`from`
   its own wallet, `to` = `payTo`, `value` = that `amount`) and retries with the
   base64 `PaymentPayload` in `PAYMENT-SIGNATURE`.
3. The worker refuses anything that is not exactly what it offered — another amount,
   recipient, asset, network, or an expired authorization — without calling the
   facilitator. Otherwise it calls `/verify` (free), then `/settle`, passing the
   facilitator **our** requirements, never the buyer's copy of them.
4. `200` with the receipt, and `PAYMENT-RESPONSE` (`{success, transaction, network,
   payer, amount}`):

```json
{
  "verified": true,
  "advisory": true,
  "settled_via": "facilitator",
  "tx_hash": "0x…",
  "payer": "0x…",
  "amount_usdc": 1,
  "floor_usdc": 1,
  "pricing_tier": "genesis",
  "confirmations_required": 300,
  "next_slot": "w1-b0011",
  "state_root": "…",
  "expires_at": "…",
  "next_step": "settled through the facilitator; wait 300 Base blocks (about 10 minutes), then open the claim per https://thefirstwall.ai/skill.md with this transaction hash as base_tx_hash"
}
```

5. The agent waits for 300 confirmations and posts its claim as `skill.md` describes,
   signed by the same wallet, with `tx_hash` as `base_tx_hash`. The ledger verifier
   proves the payment on Base itself: the USDC `Transfer` log of a facilitator
   settlement names the buyer as sender, which is what the verifier binds the claim to.

Failure answers: `402` when the payment is refused (the reason is the facilitator's,
or ours), `503` with `retryable: true` when the facilitator or `state.json` cannot be
reached or the worker's credentials are refused, `429` when rate limited. A settle
that gets **no answer** is a `503` that says the outcome is unknown: the buyer's
authorization nonce may already be spent, so the buyer looks for a transfer from its
wallet before signing again, and sends that transaction's hash if it landed.

**x402 v2 only.** v1 payloads (`scheme` at the top level, no `accepted`) get a `400`
that says so.

### Near a tier boundary: two payment options

The `exact` scheme refuses an overpayment, while the ledger assigns blocks in
settlement order and charges the tier price of the block a claim lands in. So, within
`NEAR_BOUNDARY_BLOCKS` (10) of the end of a tier, `accepts[]` lists the current floor
**and** the next tier's price; an agent that pays the higher one is certain to cover
its block. Far from a boundary there is exactly one option, so no client is nudged
into overpaying. (The plain-transfer path accepts any amount ≥ the floor, as before.)

### The plain-transfer flow (unchanged)

An agent that does not speak x402 — or paid before it saw a `402` — sends the hash of
a settled USDC transfer to `payTo` in `X-PAYMENT`: a bare `0x…` hash, raw or base64,
or a `PaymentPayload` with `payload.txHash`. Overpayment is accepted; nothing is ever
refunded; an unused settlement stays valid for a later claim by the same wallet. The
worker answers with the receipt below. This path needs no facilitator and no key.

### Verification logic for a plain transfer (the security-relevant code)

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
   where:
   - `sender` (topic 1) is the payer — this *is* the sender binding;
   - `recipient` (topic 2) == `payTo`;
   - `amount` (data) **≥ the current floor** read from `state.json`
     (1.00 USDC = 1,000,000 base units in the genesis tier). The largest such
     transfer in the transaction is the settlement. Below the floor is a final
     (non-retryable) 402 naming both amounts. No readable floor is a `503`; no price
     is ever assumed.
4. If the proof declares a payer (`payload.authorization.from` / `payer`), it must
   equal the Transfer sender.
5. **Finality:** the chain head is read from the agreeing endpoints (the
   quorum-th highest answer) and the transfer must be at least
   `MIN_CONFIRMATIONS` (default 300, the ledger's rule) blocks deep. A shallower
   payment gets a retryable 402 naming the block to retry after, so an agent never
   opens a PR the ledger verifier would reject as too shallow.
6. `next_slot` comes from `state.json` (cached up to a minute) together with the
   `merkle_root` it was read against.

### The receipt is advisory, and bound

A receipt carries the transaction, the payer, the amount, the floor and tier it was
checked against, `next_slot`, `state_root`, `state_last_updated`, `issued_at` and
`expires_at` (10 minutes), plus `advisory: true` (a plain-transfer receipt also carries
`block_number`, `confirmations` and `rpc_agreement`). It restates public facts and the
live next slot; nothing downstream trusts it — the ledger verifier re-checks the
payment itself on every PR. That is what makes a replayed or forged receipt
worthless: it grants nothing. A failed check says `retryable: true` (not found yet,
no quorum yet, too shallow, an outage) or `retryable: false` (wrong recipient, amount,
payer, reverted, expired).

No state means no replay table — and none is needed: this worker grants nothing but
a receipt. **A transaction hash can never inscribe two slots**; that replay check
lives in the ledger verifier, where the ledger lives. A signed authorization cannot
settle twice either: its nonce is spent on the first transfer.

### Protecting the free plan

A `402` route that anyone can call is only safe if answering it is cheap. Three layers:

1. **Cheap answers.** The `402` needs `state.json`, read **once per
   `STATE_CACHE_SECONDS` (default 60)** per isolate, and per colo through the Cache
   API where it applies. Cloudflare documents the Cache API for custom domains; on
   `workers.dev` it is not confirmed, so the in-memory copy is the layer that always
   works. A failed read is remembered for 5 seconds only. A malformed payment header
   and a deployment without a facilitator key are answered with no fetch at all.
2. **A per-client limit on anything that spends.** A well-formed payment is limited to
   10 per client IP per minute, via the Cloudflare rate-limiting binding
   `CLAIM_RATE_LIMITER` when configured (see `wrangler.toml`), otherwise a per-isolate
   token bucket. A limited request reaches no facilitator, no RPC endpoint and not
   even `state.json`.
3. **A rate-limit rule on the hostname** (Cloudflare dashboard → Security → WAF →
   Rate limiting rules) caps raw request counts, which is the only guard for the plan's
   request quota. It needs the hostname on a zone, i.e. the custom domain; on
   `workers.dev` it cannot be set, and the plan's own limits are the ceiling.

## (b) Deployment — ⚠️ OPERATOR TODO (the human steps)

Everything below requires a **human with a Cloudflare account and a Coinbase
Developer Platform (CDP) account**. These are the only manual steps in the pipeline;
everything before (this repo) and after (Bazaar indexing, claim PRs) is automated.

1. **Prereqs:** Node.js ≥ 22, `npm install -g wrangler` (or use `npx wrangler`).
2. **Authenticate to Cloudflare — pick one:**
   - Interactive: `wrangler login` (opens a browser), **or**
   - Headless CI: create a Cloudflare **API token** (Dashboard → My Profile → API
     Tokens → "Edit Cloudflare Workers" template is sufficient — it needs only
     *Account → Workers Scripts: Edit*), then export:
     ```bash
     export CLOUDFLARE_API_TOKEN="…"       # secret; lives in your shell/CI vault, never in git
     export CLOUDFLARE_ACCOUNT_ID="…"      # visible in the dashboard URL; not secret
     ```
     (`wrangler.toml` intentionally carries **no** `account_id`/`zone_id`.)
3. **Create the facilitator key.** In the CDP portal create a **Secret API key** with
   signature algorithm **Ed25519** (ECDSA/PEM keys are not supported by the worker).
   You get a key id and a base64 secret (64 bytes: seed, then public key).
4. **Store it as wrangler secrets** (never in git):
   ```bash
   npx wrangler secret put CDP_API_KEY_ID
   npx wrangler secret put CDP_API_KEY_SECRET
   ```
5. **Deploy:**
   ```bash
   cd x402-worker
   npx wrangler deploy
   ```
6. **Pin the domain** (recommended; it also enables the Cache API and a WAF rate-limit
   rule): attach `x402.thefirstwall.ai` as a custom domain for the worker (dashboard →
   Workers & Pages → the worker → Settings → Domains & Routes), or uncomment the
   `routes` line in `wrangler.toml` once the `thefirstwall.ai` zone is on the deploying
   account. If the final URL differs, update `RESOURCE_URL` in `wrangler.toml` to
   match — the x402 `resource.url` must be truthful. Then add the rate-limit rule on
   that hostname.
7. **Smoke it:**
   ```bash
   BASE_URL=https://x402.thefirstwall.ai ./test/dryrun.sh
   ```
   Step 5 of the script sends an unsigned payload: expect `402` from the facilitator
   (credentials accepted, payment refused), not `503`. A `503` there means the key was
   not stored or the facilitator refused it.
8. **Validate for the Bazaar** and make the first paid call — section (c).

No DNS change is needed for `thefirstwall.ai` itself; this worker lives on its own
subdomain and the static site stays as-is.

**Before the first live payment,** confirm the USDC EIP-712 domain the worker offers
(`extra.name` / `extra.version`) against the token itself; a wrong name makes every
buyer signature invalid. On Base mainnet it is `USD Coin` and `2` (checked against the
contract on 2026-10-12; the Base Sepolia test token calls itself `USDC`):

```bash
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)"    --rpc-url https://mainnet.base.org
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "version()(string)" --rpc-url https://mainnet.base.org
```

## (c) Bazaar discovery

`extensions.bazaar` in the `402` is the x402 Foundation's
[Bazaar extension](https://github.com/coinbase/x402/blob/main/specs/extensions/bazaar.md)
(`{info, schema}`; a `GET` input, a receipt-shaped example output, and a schema that
validates `info`), and `resource.description` (≤ 500 characters) says what the route
does and when to call it. Per
[Get discovered (Bazaar)](https://docs.cdp.coinbase.com/x402/seller/get-discovered):

1. **Deploy** the route to a public HTTPS URL (section (b)).
2. **Validate the endpoint** (no API key):
   ```bash
   curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
     -H "Content-Type: application/json" \
     -d '{"resource": "https://x402.thefirstwall.ai/claim", "method": "GET"}'
   ```
   Expect `valid: true`, `simulation.outcome: "accepted"`; review the `preflight`
   advisories.
3. **Complete one successful paid call through the facilitator.** Indexing is *earned*:
   "a resource becomes indexed when a paid call settles through the CDP Facilitator."
   The worker passes `paymentPayload.resource` and `extensions.bazaar` on the
   settlement, adding them when the client did not echo them. Make the call with an x402
   client (for example the reserved partner tribute for blocks #0002–#0010).
4. **Stay listed:** a route that goes 30 days without a settlement is dropped, and an
   endpoint that stops answering `402` is delisted. Ranking blends relevance with
   recent call volume and unique payers over ~30 days, so a new resource starts at the
   floor.

## Testing

```bash
# unit tests with a stubbed network and facilitator: the 402 and its Bazaar block,
# signed payments (verify, settle, failures, outages), the CDP JWT, proofs, quorum,
# finality, the state cache, the rate limit
npm test

# the endpoint end to end (local dev or deployed)
npm run dev            # in one terminal
BASE_URL=http://127.0.0.1:8787 ./test/dryrun.sh

# prove the verification logic against real Base mainnet USDC transfers
node test/verify_transfer.js              # auto-discovers a real transfer to pay_to
node test/verify_transfer.js 0x<txHash>   # verify one specific transaction
```

The unit tests never touch the network or a real facilitator. What they cannot prove
is the facilitator's own behaviour: the first live payment (section (b), step 8) is
the real test, and a Base Sepolia dry run through the CDP testnet facilitator is the
way to rehearse it with test USDC.

## x402 spec notes & uncertainties

Resolved from the specs (x402 `specs/x402-specification-v2.md`, `specs/transports-v2/http.md`,
`specs/schemes/exact/scheme_exact_evm.md`, `specs/extensions/bazaar.md`) and the CDP docs:

- v2 HTTP transport: `PAYMENT-REQUIRED` (server→client, base64 `PaymentRequired`:
  `x402Version`, `error`, `resource`, `accepts[]`, `extensions`), `PAYMENT-SIGNATURE`
  (client→server, base64 `PaymentPayload`: `x402Version`, `resource`, `accepted`,
  `payload`, `extensions`), `PAYMENT-RESPONSE` (server→client, base64
  `SettlementResponse`).
- `accepts[]` entry for `exact` on EVM: `{scheme, network (CAIP-2), amount, asset,
  payTo, maxTimeoutSeconds, extra: {name, version, assetTransferMethod}}`; `extra`
  carries the EIP-712 domain of the token and `eip3009`.
- Facilitator API: `POST /verify` → `{isValid, invalidReason?, payer?}`; `POST /settle`
  → `{success, errorReason?, payer?, transaction, network, amount?}`. CDP's lives at
  `https://api.cdp.coinbase.com/platform/v2/x402`, authenticated with a short-lived
  Ed25519 JWT (`alg: EdDSA`, `kid`, `nonce`; claims `sub`, `iss: cdp`,
  `aud: [cdp_service]`, `nbf`, `exp`, `uri: "METHOD host/path"`). Verification is
  free; the first 1,000 settlements a month are free, then $0.001 each.

**Unresolved / judged trade-offs (flagged honestly):**

1. **Header naming.** v2 names the proof header `PAYMENT-SIGNATURE`; v1 used
   `X-PAYMENT`. We accept both for payments, and answer with both `PAYMENT-RESPONSE`
   and `X-PAYMENT-RESPONSE`. v1 *payloads* are not accepted.
2. **The `uri` claim format** (`METHOD host/path`) comes from CDP's authentication
   guide; the first live call confirms it. A wrong format shows up as the facilitator
   refusing the credentials (`503`, "refused this worker's credentials").
3. **`bazaar` fields.** The extension spec defines `info.input` and `info.output`
   (`type`, `example`); it does not define `name` or `tags`, so none are emitted. The
   description lives in `resource.description`. Whether the catalog reads anything
   beyond what the spec lists is undocumented.
4. **Settle with no answer.** The transfer may have been broadcast. The worker says so
   instead of guessing, and the plain-transfer path is the way to recover.
5. **Amount semantics.** The `exact` scheme needs the exact amount, so a signed payment
   covers the floor, or the next tier's price within 10 blocks of a boundary. The
   ledger verifier remains the authority: it checks the payment against the tier price
   of the block the claim is actually assigned, in settlement order among pending
   claims. State is cached for up to a minute, so across a boundary a stale floor can
   be named for that long; an underpaid claim then waits and no block is consumed.
   Overpayment is accepted and never refunded.
