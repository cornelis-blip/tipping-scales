/**
 * bulk-associations — add or remove HubSpot associations in bulk, from a list.
 *
 * The gap this fills:
 *   HubSpot imports can *add* associations but never *remove* them, and the 2024
 *   native workflow actions only create/label associations. There is still no
 *   no-code way to bulk-REMOVE associations, or to do either from a list at
 *   scale. Both are API-only — this wraps the v4 batch endpoints to do it.
 *
 * Endpoints used (note the subtly different `to` shapes — a common trip-up):
 *   create           POST /crm/v4/associations/{from}/{to}/batch/create
 *                    input: { from:{id}, to:{id}, types:[{associationCategory, associationTypeId}] }
 *   archive ALL      POST /crm/v4/associations/{from}/{to}/batch/archive
 *                    input: { from:{id}, to:[{id}] }          ← `to` is an ARRAY
 *   archive a label  POST /crm/v4/associations/{from}/{to}/batch/labels/archive
 *                    input: { from:{id}, to:{id}, types:[{associationCategory, associationTypeId}] }
 *
 * Host-agnostic core: pure functions taking an injected `fetch`, so it runs in a
 * Node script (see run.js), a serverless function, or a custom coded action, and
 * is fully testable. All destructive ops honour a dryRun flag.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const HUBSPOT_API = 'https://api.hubapi.com';
const BATCH_LIMIT = 100; // conservative, matches v4 batch caps

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, n = BATCH_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function withRetry(fn, { retries = 3, baseDelayMs = 350 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status;
      if (status !== 429 || attempt >= retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 150));
      attempt++;
    }
  }
}

async function hsFetch(path, { method = 'GET', token, body, fetchFn }) {
  return fetchFn(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const safeText = (res) => res.text().then((t) => t).catch(() => '');

/** Parse a simple "fromId,toId" list (one pair per line). Skips a header / any non-numeric line. */
function parsePairs(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((s) => s.trim()))
    .filter((c) => c.length >= 2 && /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]))
    .map((c) => ({ from: c[0], to: c[1] }));
}

/** List association types (labels) between two object types. */
async function getAssociationLabels({ fromType, toType }, { token, fetchFn = fetch }) {
  const res = await withRetry(() =>
    hsFetch(`/crm/v4/associations/${fromType}/${toType}/labels`, { token, fetchFn })
  );
  if (!res.ok) {
    throw Object.assign(new Error(`labels lookup failed: ${res.status}`), { status: res.status });
  }
  return (await res.json()).results || [];
}

/**
 * Resolve an association label name (or "default") to { associationCategory, associationTypeId }.
 * "default" / null → the unlabeled HUBSPOT_DEFINED (primary) association.
 */
async function resolveType({ fromType, toType, label }, ctx) {
  const labels = await getAssociationLabels({ fromType, toType }, ctx);
  const wantDefault = label == null || label === '' || String(label).toLowerCase() === 'default';

  const match = wantDefault
    ? labels.find((l) => l.category === 'HUBSPOT_DEFINED' && (l.label == null || l.label === ''))
    : labels.find((l) => (l.label || '').toLowerCase() === String(label).toLowerCase());

  if (!match) {
    const available = labels.map((l) => l.label ?? 'default').join(', ') || '(none)';
    throw new Error(`association label "${label}" not found. Available: ${available}`);
  }
  return { associationCategory: match.category, associationTypeId: match.typeId };
}

// ─── Batch operations ────────────────────────────────────────────────────────

async function runBatches({ op, path, buildInput, pairs }, ctx) {
  const { token, fetchFn = fetch, dryRun = false } = ctx;
  const summary = { op, total: pairs.length, batches: 0, succeeded: 0, failed: 0, errors: [], dryRun };

  for (const group of chunk(pairs)) {
    summary.batches++;
    if (dryRun) {
      summary.succeeded += group.length;
      continue;
    }
    const inputs = group.map(buildInput);
    const res = await withRetry(() => hsFetch(path, { method: 'POST', token, fetchFn, body: { inputs } }));
    if (res.status === 204 || res.ok) {
      summary.succeeded += group.length;
    } else {
      summary.failed += group.length;
      summary.errors.push({ status: res.status, detail: await safeText(res) });
    }
  }
  return summary;
}

/** Create associations between pairs, using an explicit type ({associationCategory, associationTypeId}). */
function batchCreate({ fromType, toType, pairs, type }, ctx = {}) {
  return runBatches(
    {
      op: 'create',
      path: `/crm/v4/associations/${fromType}/${toType}/batch/create`,
      buildInput: (p) => ({ from: { id: String(p.from) }, to: { id: String(p.to) }, types: [type] }),
      pairs,
    },
    ctx
  );
}

/** Remove ALL associations between each pair. Note: `to` must be an array here. */
function batchArchive({ fromType, toType, pairs }, ctx = {}) {
  return runBatches(
    {
      op: 'archive',
      path: `/crm/v4/associations/${fromType}/${toType}/batch/archive`,
      buildInput: (p) => ({ from: { id: String(p.from) }, to: [{ id: String(p.to) }] }),
      pairs,
    },
    ctx
  );
}

/** Remove only a specific labeled association between each pair, keeping others. */
function batchArchiveLabeled({ fromType, toType, pairs, type }, ctx = {}) {
  return runBatches(
    {
      op: 'archive-label',
      path: `/crm/v4/associations/${fromType}/${toType}/batch/labels/archive`,
      buildInput: (p) => ({ from: { id: String(p.from) }, to: { id: String(p.to) }, types: [type] }),
      pairs,
    },
    ctx
  );
}

module.exports = {
  parsePairs,
  getAssociationLabels,
  resolveType,
  batchCreate,
  batchArchive,
  batchArchiveLabeled,
  _internal: { chunk, withRetry, BATCH_LIMIT },
};
