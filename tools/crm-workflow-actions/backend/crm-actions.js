/**
 * crm-actions — backend for the "CRM Toolkit" HubSpot workflow actions.
 *
 * The app (../app) defines four workflow actions with dropdowns. HubSpot routes
 * each execution to this backend's actionUrl, which performs the CRM API call
 * and returns { outputFields }. It also serves the dynamic property dropdown
 * (optionsUrl).
 *
 * This file is a host-agnostic CORE: pure async functions that take an injected
 * `fetch`, so they run anywhere (Node server, Cloudflare Workers, Vercel, Twilio
 * Functions) and are trivially testable. See server.js for a minimal Node
 * adapter and crm-actions.test.js for tests.
 *
 * Auth model: this backend calls HubSpot with a PRIVATE APP TOKEN it holds in
 * env (HUBSPOT_TOKEN) — the execution payload does not carry an access token.
 * Suitable for a private/internal app. A public OAuth app would instead look up
 * a stored per-portal token here.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const HUBSPOT_API = 'https://api.hubapi.com';

// Operators offered by the Search action's dropdown → HubSpot search operators.
const VALUELESS_OPERATORS = new Set(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);

async function hsFetch(path, { method = 'GET', token, body, fetchFn }) {
  return fetchFn(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ok = (outputFields) => ({ statusCode: 200, body: { outputFields } });

/** Return 200 to HubSpot but surface an errorCode output so workflows can branch. */
async function apiError(res, extra = {}) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  console.error(`[crm-actions] HubSpot API ${res.status}: ${detail}`);
  return ok({ ...extra, errorCode: `HTTP_${res.status}` });
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function actionSearch(f, env, fetchFn) {
  const filter = { propertyName: f.property, operator: f.operator };
  if (!VALUELESS_OPERATORS.has(f.operator)) filter.value = f.value;

  const res = await hsFetch(`/crm/v3/objects/${f.objectType}/search`, {
    method: 'POST',
    token: env.HUBSPOT_TOKEN,
    fetchFn,
    body: { filterGroups: [{ filters: [filter] }], limit: 1, properties: ['hs_object_id'] },
  });
  if (!res.ok) return apiError(res, { found: 'false' });

  const data = await res.json();
  const first = data.results?.[0];
  return ok({ found: first ? 'true' : 'false', recordId: first?.id ?? '', total: data.total ?? 0 });
}

async function actionGet(f, env, fetchFn) {
  const path = `/crm/v3/objects/${f.objectType}/${encodeURIComponent(f.recordId)}?properties=${encodeURIComponent(f.property)}`;
  const res = await hsFetch(path, { token: env.HUBSPOT_TOKEN, fetchFn });
  if (res.status === 404) return ok({ found: 'false', value: '' });
  if (!res.ok) return apiError(res, { found: 'false', value: '' });

  const data = await res.json();
  return ok({ found: 'true', value: data.properties?.[f.property] ?? '' });
}

async function actionDelete(f, env, fetchFn) {
  // Guard rail: require the literal word DELETE in the confirm field.
  if (f.confirm !== 'DELETE') return ok({ deleted: 'false', status: 'not-confirmed' });

  const res = await hsFetch(`/crm/v3/objects/${f.objectType}/${encodeURIComponent(f.recordId)}`, {
    method: 'DELETE',
    token: env.HUBSPOT_TOKEN,
    fetchFn,
  });
  if (res.status === 204 || res.ok) return ok({ deleted: 'true', status: 'deleted' });
  return apiError(res, { deleted: 'false' });
}

async function actionBatchUpdate(f, env, fetchFn) {
  const ids = String(f.recordIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return ok({ updatedCount: 0, status: 'no-ids' });

  const res = await hsFetch(`/crm/v3/objects/${f.objectType}/batch/update`, {
    method: 'POST',
    token: env.HUBSPOT_TOKEN,
    fetchFn,
    body: { inputs: ids.map((id) => ({ id, properties: { [f.property]: f.value } })) },
  });
  if (!res.ok) return apiError(res, { updatedCount: 0, status: 'failed' });

  const data = await res.json();
  return ok({ updatedCount: data.results?.length ?? ids.length, status: 'ok' });
}

const ACTIONS = {
  search: actionSearch,
  get: actionGet,
  delete: actionDelete,
  'batch-update': actionBatchUpdate,
};

/**
 * Dispatch a workflow-action execution.
 * @param {string} op        One of: search | get | delete | batch-update
 * @param {object} body      The execution payload HubSpot POSTed (has inputFields)
 * @param {object} env       { HUBSPOT_TOKEN }
 * @param {function} [fetchFn]
 */
async function handleAction(op, body, env, fetchFn = fetch) {
  const action = ACTIONS[op];
  if (!action) return { statusCode: 404, body: { message: `unknown action: ${op}` } };
  return action(body?.inputFields || {}, env, fetchFn);
}

/**
 * Serve the dynamic property dropdown for the chosen object type (optionsUrl).
 * HubSpot sends the already-filled inputFields, so we read objectType from there.
 */
async function handleOptions(body, env, fetchFn = fetch) {
  const objectType = body?.inputFields?.objectType || 'contacts';
  const q = String(body?.fetchOptions?.q || '').toLowerCase();

  const res = await hsFetch(`/crm/v3/properties/${objectType}`, { token: env.HUBSPOT_TOKEN, fetchFn });
  if (!res.ok) return { options: [] };

  const data = await res.json();
  let options = (data.results || []).map((p) => ({
    label: `${p.label} (${p.name})`,
    value: p.name,
    description: p.description || undefined,
  }));
  if (q) options = options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));

  return { options: options.slice(0, 100), searchable: true };
}

module.exports = { handleAction, handleOptions, _actions: ACTIONS };
