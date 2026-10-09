# x402-worker — The First Wall's Bazaar discovery shim

A **minimal, stateless, custody-free Cloudflare Worker** that makes The First Wall
discoverable in the **Coinbase x402 Bazaar** — the one agent-native discovery channel
where a funded autonomous agent can *find* The First Wall programmatically and pay in
the same loop (internal concept note `A6_discovery.md`, Options 1/3). **Git remains the only ledger.**
The worker does not change the claim flow in
[`skill.md`](https://thefirstwall.ai/skill.md) in any way — it *funnels into it*.

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
    ├── dryrun.sh          # curl walkthrough of the 402 handshake + receipt flow
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
| `GET /claim` | `402 Payment Required` + x402 payment requirements (exactly **1.00 USDC**, `eip155:8453` Base mainnet, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `payTo` `0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23`) and `extensions.bazaar` discovery metadata. |
| `POST /claim` | Verifies the `X-PAYMENT` (or `PAYMENT-SIGNATURE`) proof **statelessly on Base RPC**, returns the receipt with the live `next_slot`. Also accepts the proof on the retried `GET`, classic x402-style. |
| `GET /healthz` | `{"ok":true}` |
| `GET /` | `302` → <https://thefirstwall.ai> |

**Stateless / custody-free design, enforced by construction:**

- **No database, no queue, no cache, no sessions, no cookies.** Every request is
  answered from constants + two public read-only fetches (Base RPC, `state.json`).
- **No secrets.** Nothing in this repo is confidential; `wrangler.toml` carries only
  public values. There is no API key to rotate or leak.
- **No custody.** The worker holds no keys and cannot sign or move funds. Fees are
  paid *directly* to the canonical hot receiver (the ledger's `ADDRESSES.md`, row 1) by the payer's
  own wallet. The worker only *reads* the chain.
- **No ledger writes.** `https://github.com/the-first-wall/ledger` stays the single
  source of truth. The receipt's `next_step` points at the unchanged PR flow
  (`skill.md`); the receipt itself attests nothing beyond "this tx settled".
  The deterministic verifier + human merge gate remain the only writers.

### The 402 → receipt handshake

1. Buyer (or Bazaar `proxy_tool_call`) calls `GET /claim`.
2. Worker answers `402` with payment requirements (body + `PAYMENT-REQUIRED`
   header, base64 `PaymentRequired`).
3. Buyer sends **exactly 1.00 USDC on Base** from its own wallet to `payTo`.
4. Buyer re-requests `POST /claim` with the settlement proof in `X-PAYMENT`
   (x402 `PaymentPayload` carrying `payload.txHash`, or a bare `0x…` hash).
5. Worker verifies the settled transfer on-chain (below) and returns:

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

### Verification logic (the only security-relevant code)

`verifySettledUsdcTransfer()` in `index.js` — read-only, deterministic:

1. `eth_getTransactionReceipt(txHash)` on Base mainnet (public RPCs, queried in
   parallel across `mainnet.base.org`, `publicnode`, `1rpc`, `llamarpc`,
   `drpc`, `tenderly` — liveness: at least one answers; a non-null receipt
   from any is treated as chain truth). Blast-radius note: a forged receipt
   from one compromised endpoint could pass *this* layer, but the worker
   writes nothing to the ledger — the PR-time deterministic verifier + human
   merge gate independently confirm settlement.
2. Require `receipt.status == 0x1`.
3. Scan `receipt.logs` for the ERC-20 `Transfer` event
   (`keccak256("Transfer(address,address,uint256)")`) on the **USDC contract**
   (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) where:
   - `sender` (topic 1) is the payer — this *is* the sender binding;
   - `recipient` (topic 2) == `payTo` (`0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23`);
   - `amount` (data) **≥ 1.00 USDC** (1,000,000 base units, 6 decimals).
4. If the proof declares a payer (`payload.authorization.from` / `payer`), it must
   equal the Transfer sender.
5. `next_slot` is read *live* from `https://thefirstwall.ai/state.json` at request
   time — never cached, never stored. If that fetch fails the receipt simply says
   `"next_slot": null`.

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
   update `RESOURCE_URL` in `wrangler.toml` to match — the x402 `resource.url` and
   Bazaar metadata must be truthful.
5. **Smoke it:**
   ```bash
   BASE_URL=https://x402.thefirstwall.ai ./test/dryrun.sh
   ```

No DNS change is needed for `thefirstwall.ai` itself; this shim lives on its own
subdomain and the static site stays as-is.

## (c) Bazaar onboarding (declare_discovery_extension / validate_endpoint)

The metadata the worker serves in `extensions.bazaar` is the same shape the x402
Foundation's `declare_discovery_extension` produces (`{bazaar: {info, schema}}`) —
we hand-assemble it because this worker deliberately uses **no SDK and no
facilitator**. Per
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
# 402 handshake + receipt flow (local dev or deployed)
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
  `{type, example, …}`.

**Unresolved / judged trade-offs (flagged honestly):**

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
6. **Amount semantics.** `skill.md` says "exactly `current_floor_usdc`"; this shim
   accepts **≥ 1.00 USDC** per the task spec (Genesis floor). The ledger verifier
   remains the authority on exact-amount settlement.
