#!/usr/bin/env node
/**
 * verify_transfer.js — proves the worker's verification logic against REAL
 * Base mainnet USDC transfers. Read-only: it only calls
 * eth_getTransactionReceipt / eth_getLogs / eth_blockNumber. No keys, no
 * signing, no writes. Same constants and same checks as index.js.
 *
 * Usage:
 *   node verify_transfer.js                  # auto-discover a real USDC transfer
 *                                            # to pay_to and verify it
 *   node verify_transfer.js 0x<txHash>       # verify one specific transaction
 *
 * Environment:
 *   RPC_URL   JSON-RPC endpoint (default https://mainnet.base.org)
 *
 * Exit code 0 = transfer verified, 1 = not verified / error.
 */

const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xbbF4D6B954e97C2C4fbC4e89B7933cDD7e4D9f23"; // ADDRESSES.md row 1
const PRICE_BASE_UNITS = 1000000n; // 1.00 USDC (6 decimals)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Public, keyless, read-only Base mainnet endpoints (tried in order).
const RPC_URLS = [
  process.env.RPC_URL || "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
];
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  let lastErr = new Error("no RPC endpoint reached");
  for (const url of RPC_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`RPC HTTP ${res.status} at ${url}`);
          await sleep(1000 * (attempt + 1));
          continue; // back off, retry, then fall through to next URL
        }
        if (!res.ok) throw new Error(`RPC HTTP ${res.status} at ${url}`);
        const out = await res.json();
        if (out.error) {
          // Application-level error: same on every endpoint (e.g. getLogs range
          // limits) — surface it immediately so the caller can adapt.
          const err = new Error(`RPC error: ${out.error.message}`);
          err.appError = true;
          throw err;
        }
        return out.result;
      } catch (err) {
        if (err.appError) throw err;
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

function addrFromTopic(topic) {
  return ("0x" + topic.slice(26)).toLowerCase();
}

/** Identical checks to verifySettledUsdcTransfer() in index.js. */
async function verifySettledUsdcTransfer(txHash, declaredPayer = null) {
  if (!TX_HASH_RE.test(txHash)) return { ok: false, reason: "malformed transaction hash" };
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ok: false, reason: "transaction not found on Base (yet)" };
  if (receipt.status !== "0x1") return { ok: false, reason: "transaction reverted" };
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
      return { ok: false, reason: "payer mismatch: proof payer != USDC Transfer sender" };
    }
    return {
      ok: true,
      payer: from,
      value_base_units: value.toString(),
      value_usdc: (Number(value) / 1e6).toFixed(2),
      blockNumber: receipt.blockNumber,
    };
  }
  return {
    ok: false,
    reason:
      "no USDC Transfer log from the payer to pay_to with amount >= 1.00 USDC in this transaction",
  };
}

/** Find a real historical USDC Transfer into pay_to (read-only eth_getLogs).
 *  Adapts the scan window to each endpoint's eth_getLogs range limit. */
async function discoverRealTransfer() {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  let chunk = 10000; // start big (mainnet.base.org / publicnode allow this)
  let scanned = 0;
  const MAX_SCAN = 100000; // ~2 days of Base (~2s blocks)
  const payToWord = "0x" + "0".repeat(24) + PAY_TO.slice(2).toLowerCase();
  while (scanned < MAX_SCAN && chunk >= 25) {
    const toBlock = latest - scanned;
    const fromBlock = toBlock - chunk + 1;
    if (fromBlock <= 0) break;
    try {
      const logs = await rpc("eth_getLogs", [
        {
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
          address: USDC_CONTRACT,
          topics: [TRANSFER_TOPIC, null, payToWord],
        },
      ]);
      if (logs && logs.length > 0) return logs[0].transactionHash;
      scanned += chunk;
    } catch (err) {
      // e.g. "eth_getLogs is limited to 0 - 50 blocks range"
      const m = /limited to \d+ - (\d+) blocks/i.exec(err.message);
      chunk = m ? Math.max(25, parseInt(m[1], 10) - 1) : Math.floor(chunk / 2);
    }
  }
  return null;
}

async function main() {
  let txHash = process.argv[2];
  if (!txHash) {
    console.log("No tx hash given — discovering a real USDC transfer to pay_to via eth_getLogs…");
    txHash = await discoverRealTransfer();
    if (!txHash) {
      console.error("No recent transfer found in the scanned window; pass a tx hash explicitly.");
      process.exit(1);
    }
    console.log(`Discovered: ${txHash}`);
  }
  console.log(`Verifying ${txHash} against ${RPC_URLS.join(", ")} (read-only)…`);
  const verdict = await verifySettledUsdcTransfer(txHash);
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
