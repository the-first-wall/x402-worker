// B-17: the agent card must not silently diverge from canonical discovery metadata.
// Offline: fetch is injected; nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { __test as w } from "../index.js";
import { identityFields, diffIdentity, checkDrift } from "../scripts/card-drift-lib.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/canonical-card-identity.json", import.meta.url), "utf8"));
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const emit = () => w.agentCard({});

test("emitted card identity fields match the pinned canonical fixture", () => {
  // Fails on any edit to the card's identity copy: update the fixture, CARD_VERSION
  // and CARD_UPDATED_AT together, and the ledger's discovery/agent-card.json.
  assert.deepEqual(identityFields(emit()), fixture);
});

test("card and x402 manifest agree on identity (name, description, icon, resource, tags)", async () => {
  const card = emit();
  const res = await worker.fetch(new Request("https://x.test/.well-known/x402"), {});
  const m = await res.json();
  assert.equal(card.name, m.name);
  assert.equal(card.description, m.description);
  assert.equal(card.iconUrl, m.iconUrl);
  assert.equal(card.x402.resource, m.resources[0].url);
  assert.equal(card.x402.docs, m.docs);
  assert.equal(card.x402.ledger, m.ledger);
  assert.equal(card.x402.state, m.state);
  assert.deepEqual(card.skills[0].tags, m.tags);
  assert.equal(m.agentCard, "https://x402.thefirstwall.ai/.well-known/agent-card.json");
});

test("the served card carries the pinned version and update time", async () => {
  const res = await worker.fetch(new Request("https://x.test/.well-known/agent-card.json"), {});
  const card = await res.json();
  assert.equal(card.version, w.CARD_VERSION);
  assert.equal(card.updated, w.CARD_UPDATED_AT);
  assert.match(w.CARD_UPDATED_AT, RFC3339);
  assert.match(w.MANIFEST_UPDATED, RFC3339);
});

test("diffIdentity reports drifted fields and ignores non-identity fields", () => {
  const canonical = { ...emit(), version: "9.9.9", updated: "2000-01-01T00:00:00Z", name: "Other" };
  assert.deepEqual(diffIdentity(emit(), canonical).map((d) => d.field), ["name"]);
  assert.deepEqual(diffIdentity(emit(), { ...emit(), version: "9" }), []);
});

const fakeFetch = (status, body) => async () => ({ status, ok: status < 400, json: async () => body });

test("checkDrift: match, drift, missing (404), error", async () => {
  assert.equal((await checkDrift(emit(), { fetchImpl: fakeFetch(200, emit()) })).status, "match");
  const drift = await checkDrift(emit(), { fetchImpl: fakeFetch(200, { ...emit(), iconUrl: "https://evil.test/i.png" }) });
  assert.equal(drift.status, "drift");
  assert.equal(drift.diffs[0].field, "iconUrl");
  assert.equal((await checkDrift(emit(), { fetchImpl: fakeFetch(404) })).status, "missing");
  assert.equal((await checkDrift(emit(), { fetchImpl: fakeFetch(500) })).status, "error");
  assert.equal((await checkDrift(emit(), { fetchImpl: async () => { throw new Error("down"); } })).status, "error");
});
