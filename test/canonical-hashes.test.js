// The Worker's two discovery documents are mirrored byte-for-byte (ledger
// discovery/x402.json + discovery/agent-card.json, web apex). Their sha256 is
// pinned here: ANY byte change fails this test. To change a document, update the
// pin below AND the README "Canonical integrity hashes" table, and bump
// MANIFEST_UPDATED (manifest) or CARD_VERSION + CARD_UPDATED_AT (card) in index.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { __test as w } from "../index.js";

const MANIFEST_SHA256 = "53d3120d465eb87ea7ed8863089e7d1ebb8b7923594e47d0c2c16a544fb2020b";
const CARD_SHA256 = "f6af60d18b59bce88922003678d31a9b0e348f7b2f55236161d95c9b13394553";
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HOWTO = "update the pin + README 'Canonical integrity hashes' + bump MANIFEST_UPDATED (manifest) or CARD_VERSION/CARD_UPDATED_AT (card)";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const get = async (path, env = {}, method = "GET") => worker.fetch(new Request(`https://x.test${path}`, { method }), env);
const bytes = async (path, env) => Buffer.from(await (await get(path, env)).arrayBuffer());
// A hostile/live env must not change a single byte of the manifest.
const liveEnv = { STATE_URL: "https://state.test/state.json", SITE_URL: "https://other.test", RESOURCE_URL: "https://other.test/claim" };

test("served /.well-known/x402 bytes match the pinned sha256", async () => {
  assert.equal(sha256(await bytes("/.well-known/x402")), MANIFEST_SHA256, HOWTO);
});

test("served /.well-known/agent-card.json bytes match the pinned sha256", async () => {
  assert.equal(sha256(await bytes("/.well-known/agent-card.json")), CARD_SHA256, HOWTO);
});

test("the manifest is static: identical bytes across requests and env, none from state.json", async () => {
  const a = await bytes("/.well-known/x402");
  assert.ok(a.equals(await bytes("/.well-known/x402")));
  assert.ok(a.equals(await bytes("/.well-known/x402", liveEnv)));
  assert.ok(a.equals(Buffer.from(JSON.stringify(w.x402Manifest(), null, 2))));
  const m = JSON.parse(a.toString());
  assert.equal(m.resources[0].price, undefined);
  assert.equal(m.resources[0].accepts, undefined);
});

test("the card is stable across requests", async () => {
  assert.ok((await bytes("/.well-known/agent-card.json")).equals(await bytes("/.well-known/agent-card.json")));
});

test("GET and HEAD agree on status and headers; HEAD has no body", async () => {
  for (const path of ["/.well-known/x402", "/.well-known/agent-card.json"]) {
    const g = await get(path);
    const h = await get(path, {}, "HEAD");
    assert.equal(h.status, g.status);
    for (const k of ["content-type", "cache-control", "access-control-allow-origin"]) assert.equal(h.headers.get(k), g.headers.get(k));
    if (path.endsWith("x402")) assert.equal((await h.arrayBuffer()).byteLength, 0);
  }
});

test("manifest carries contact + updated, points at the canonical card, resources on its own domain", async () => {
  const m = JSON.parse((await bytes("/.well-known/x402")).toString());
  assert.equal(new URL(m.contact).protocol, "https:");
  assert.match(m.updated, RFC3339);
  assert.equal(m.updated, w.MANIFEST_UPDATED);
  assert.equal(m.agentCard, "https://x402.thefirstwall.ai/.well-known/agent-card.json");
  const apex = new URL(m.site).hostname;
  for (const r of m.resources) {
    const host = new URL(r.url).hostname;
    assert.ok(host === apex || host.endsWith(`.${apex}`), `${r.url} must be on ${apex} or a subdomain`);
  }
});
