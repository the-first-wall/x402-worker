// Identity-field comparison shared by test/ and scripts/check-card-drift.mjs.
// Only fields that identify the service are compared; version/updated and
// presentation-only fields are not (see the circularity note in index.js).

export const DEFAULT_CANONICAL_URL =
  "https://raw.githubusercontent.com/the-first-wall/ledger/main/discovery/agent-card.json";

const sortedTags = (tags) => (Array.isArray(tags) ? [...tags].sort() : null);

// Reduce an agent card (worker-emitted or canonical) to its identity fields.
export function identityFields(card) {
  const skills = Array.isArray(card?.skills) ? card.skills : [];
  return {
    name: card?.name ?? null,
    description: card?.description ?? null,
    iconUrl: card?.iconUrl ?? null,
    url: card?.url ?? null,
    x402Resource: card?.x402?.resource ?? null,
    skills: skills.map((s) => ({ id: s.id ?? null, name: s.name ?? null, tags: sortedTags(s.tags) })),
  };
}

// Field-by-field differences, [] when identical.
export function diffIdentity(emitted, canonical) {
  const a = identityFields(emitted);
  const b = identityFields(canonical);
  return Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({ field: k, worker: a[k], canonical: b[k] }));
}

// Returns { status: "match"|"drift"|"missing"|"error", diffs?, detail? }.
export async function checkDrift(emittedCard, { url = DEFAULT_CANONICAL_URL, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (e) {
    return { status: "error", detail: `fetch failed: ${e.message}` };
  }
  if (res.status === 404) return { status: "missing", detail: `${url} -> 404` };
  if (!res.ok) return { status: "error", detail: `${url} -> HTTP ${res.status}` };
  let canonical;
  try {
    canonical = await res.json();
  } catch (e) {
    return { status: "error", detail: `canonical card is not JSON: ${e.message}` };
  }
  const diffs = diffIdentity(emittedCard, canonical);
  return diffs.length ? { status: "drift", diffs } : { status: "match" };
}
