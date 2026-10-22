// Fail when the worker's emitted agent card drifts from the canonical discovery
// metadata. Usage: node scripts/check-card-drift.mjs [--strict]
//   CANONICAL_CARD_URL overrides the source (default: ledger main discovery/agent-card.json).
// Without --strict, a missing canonical file (404) or a network error only warns:
// the ledger copy may not have landed yet. With --strict, anything but a match fails.
// Read-only: no credentials, no deploy.
import { __test as w } from "../index.js";
import { checkDrift, DEFAULT_CANONICAL_URL } from "./card-drift-lib.mjs";

const strict = process.argv.includes("--strict");
const url = process.env.CANONICAL_CARD_URL || DEFAULT_CANONICAL_URL;
const result = await checkDrift(w.agentCard({}), { url });

switch (result.status) {
  case "match":
    console.log(`agent card matches canonical discovery metadata (${url})`);
    break;
  case "drift":
    for (const d of result.diffs) {
      console.error(`DRIFT ${d.field}\n  worker:    ${JSON.stringify(d.worker)}\n  canonical: ${JSON.stringify(d.canonical)}`);
    }
    process.exit(1);
  default:
    console.warn(`${strict ? "ERROR" : "WARN"}: could not verify card (${result.status}): ${result.detail}`);
    process.exit(strict ? 1 : 0);
}
