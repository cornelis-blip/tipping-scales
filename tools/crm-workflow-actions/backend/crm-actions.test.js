/**
 * Tests for crm-actions core. Run with:  node --test
 * No install: Node's built-in runner + an injected fake fetch. Node 18+.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAction, handleOptions } = require('./crm-actions');

const env = { HUBSPOT_TOKEN: 'pat-test' };

/** Fake fetch: records calls, returns scripted responses by URL substring. */
function makeFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    const h = handlers.find((x) => url.includes(x.match)) || {};
    return {
      ok: h.ok ?? true,
      status: h.status ?? 200,
      text: async () => h.text ?? '',
      json: async () => h.json ?? {},
    };
  };
  return { fetchFn, calls };
}

test('search: builds a filter and maps the first match', async () => {
  const { fetchFn, calls } = makeFetch([
    { match: '/objects/contacts/search', json: { total: 3, results: [{ id: '801' }] } },
  ]);
  const out = await handleAction(
    'search',
    { inputFields: { objectType: 'contacts', property: 'email', operator: 'EQ', value: 'a@b.com' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.found, 'true');
  assert.equal(out.body.outputFields.recordId, '801');
  assert.equal(out.body.outputFields.total, 3);
  assert.equal(calls[0].body.filterGroups[0].filters[0].value, 'a@b.com');
});

test('search: valueless operator (HAS_PROPERTY) omits value', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/search', json: { total: 0, results: [] } }]);
  const out = await handleAction(
    'search',
    { inputFields: { objectType: 'deals', property: 'amount', operator: 'HAS_PROPERTY' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.found, 'false');
  assert.ok(!('value' in calls[0].body.filterGroups[0].filters[0]));
});

test('get: returns the requested property value', async () => {
  const { fetchFn, calls } = makeFetch([
    { match: '/objects/companies/', json: { id: '5', properties: { name: 'Acme' } } },
  ]);
  const out = await handleAction(
    'get',
    { inputFields: { objectType: 'companies', recordId: '5', property: 'name' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.value, 'Acme');
  assert.match(calls[0].url, /properties=name/);
});

test('get: 404 is a clean not-found, not an error', async () => {
  const { fetchFn } = makeFetch([{ match: '/objects/contacts/', ok: false, status: 404 }]);
  const out = await handleAction(
    'get',
    { inputFields: { objectType: 'contacts', recordId: '999', property: 'email' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.found, 'false');
  assert.ok(!('errorCode' in out.body.outputFields));
});

test('delete: refuses without the DELETE confirmation', async () => {
  const { fetchFn, calls } = makeFetch([]);
  const out = await handleAction(
    'delete',
    { inputFields: { objectType: 'contacts', recordId: '1', confirm: 'nope' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.deleted, 'false');
  assert.equal(calls.length, 0, 'no API call when unconfirmed');
});

test('delete: proceeds on 204 when confirmed', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/objects/contacts/1', status: 204 }]);
  const out = await handleAction(
    'delete',
    { inputFields: { objectType: 'contacts', recordId: '1', confirm: 'DELETE' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.deleted, 'true');
  assert.equal(calls[0].method, 'DELETE');
});

test('batch-update: splits ids and reports updated count', async () => {
  const { fetchFn, calls } = makeFetch([
    { match: '/batch/update', json: { results: [{ id: '1' }, { id: '2' }, { id: '3' }] } },
  ]);
  const out = await handleAction(
    'batch-update',
    { inputFields: { objectType: 'deals', recordIds: '1, 2 ,3', property: 'dealstage', value: 'closedwon' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.updatedCount, 3);
  assert.equal(calls[0].body.inputs.length, 3);
  assert.deepEqual(calls[0].body.inputs[0], { id: '1', properties: { dealstage: 'closedwon' } });
});

test('api error surfaces errorCode instead of throwing', async () => {
  const { fetchFn } = makeFetch([{ match: '/search', ok: false, status: 403, text: 'forbidden' }]);
  const out = await handleAction(
    'search',
    { inputFields: { objectType: 'contacts', property: 'email', operator: 'EQ', value: 'x' } },
    env,
    fetchFn
  );
  assert.equal(out.body.outputFields.errorCode, 'HTTP_403');
});

test('options: lists properties for the chosen object type, filtered by query', async () => {
  const { fetchFn, calls } = makeFetch([
    {
      match: '/properties/tickets',
      json: {
        results: [
          { name: 'subject', label: 'Ticket name' },
          { name: 'content', label: 'Description' },
        ],
      },
    },
  ]);
  const out = await handleOptions(
    { inputFields: { objectType: 'tickets' }, fetchOptions: { q: 'subject' } },
    env,
    fetchFn
  );
  assert.match(calls[0].url, /\/properties\/tickets/);
  assert.equal(out.options.length, 1);
  assert.equal(out.options[0].value, 'subject');
  assert.equal(out.searchable, true);
});

test('unknown action returns 404', async () => {
  const { fetchFn } = makeFetch([]);
  const out = await handleAction('frobnicate', { inputFields: {} }, env, fetchFn);
  assert.equal(out.statusCode, 404);
});
