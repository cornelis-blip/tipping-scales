/**
 * Tests for bulk-associations core. Run with:  node --test
 * No install: Node's built-in runner + injected fake fetch. Node 18+.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePairs,
  resolveType,
  batchCreate,
  batchArchive,
  batchArchiveLabeled,
} = require('./bulk-associations');

const ctxBase = { token: 'pat-test' };

function makeFetch(handlers = []) {
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

test('parsePairs reads pairs and skips a header / non-numeric lines', () => {
  const pairs = parsePairs('fromId,toId\n123,456\n 789 , 1011 \nbad,row\n');
  assert.deepEqual(pairs, [
    { from: '123', to: '456' },
    { from: '789', to: '1011' },
  ]);
});

test('batchCreate builds the create payload with to:{id} and the type', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/batch/create', json: { results: [{}, {}] } }]);
  const out = await batchCreate(
    {
      fromType: 'contacts',
      toType: 'companies',
      pairs: [{ from: '1', to: '2' }, { from: '3', to: '4' }],
      type: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 },
    },
    { ...ctxBase, fetchFn }
  );
  assert.match(calls[0].url, /\/crm\/v4\/associations\/contacts\/companies\/batch\/create/);
  assert.deepEqual(calls[0].body.inputs[0], {
    from: { id: '1' },
    to: { id: '2' },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }],
  });
  assert.equal(out.succeeded, 2);
  assert.equal(out.failed, 0);
});

test('batchArchive builds `to` as an ARRAY (the endpoint quirk)', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/batch/archive', status: 204 }]);
  const out = await batchArchive(
    { fromType: 'contacts', toType: 'companies', pairs: [{ from: '1', to: '2' }] },
    { ...ctxBase, fetchFn }
  );
  assert.deepEqual(calls[0].body.inputs[0], { from: { id: '1' }, to: [{ id: '2' }] });
  assert.equal(out.succeeded, 1); // 204 counts as success
});

test('batchArchiveLabeled targets the labels/archive path with types', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/batch/labels/archive', status: 204 }]);
  await batchArchiveLabeled(
    {
      fromType: 'deals',
      toType: 'contacts',
      pairs: [{ from: '9', to: '8' }],
      type: { associationCategory: 'USER_DEFINED', associationTypeId: 42 },
    },
    { ...ctxBase, fetchFn }
  );
  assert.match(calls[0].url, /\/batch\/labels\/archive/);
  assert.equal(calls[0].body.inputs[0].types[0].associationTypeId, 42);
});

test('chunks into batches of 100', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/batch/create', json: { results: [] } }]);
  const pairs = Array.from({ length: 150 }, (_, i) => ({ from: String(i), to: String(i + 1) }));
  const out = await batchCreate(
    { fromType: 'contacts', toType: 'companies', pairs, type: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 } },
    { ...ctxBase, fetchFn }
  );
  assert.equal(calls.length, 2, 'two batches for 150 pairs');
  assert.equal(calls[0].body.inputs.length, 100);
  assert.equal(calls[1].body.inputs.length, 50);
  assert.equal(out.batches, 2);
});

test('dryRun performs NO fetch and reports would-succeed count', async () => {
  const { fetchFn, calls } = makeFetch([]);
  const out = await batchArchive(
    { fromType: 'contacts', toType: 'companies', pairs: [{ from: '1', to: '2' }, { from: '3', to: '4' }] },
    { ...ctxBase, fetchFn, dryRun: true }
  );
  assert.equal(calls.length, 0, 'no API calls in dry run');
  assert.equal(out.dryRun, true);
  assert.equal(out.succeeded, 2);
});

test('resolveType maps a label name to category + typeId', async () => {
  const { fetchFn } = makeFetch([
    {
      match: '/associations/deals/contacts/labels',
      json: {
        results: [
          { category: 'HUBSPOT_DEFINED', typeId: 3, label: null },
          { category: 'USER_DEFINED', typeId: 42, label: 'Decision maker' },
        ],
      },
    },
  ]);
  const type = await resolveType({ fromType: 'deals', toType: 'contacts', label: 'decision maker' }, { ...ctxBase, fetchFn });
  assert.deepEqual(type, { associationCategory: 'USER_DEFINED', associationTypeId: 42 });
});

test('resolveType "default" picks the unlabeled HUBSPOT_DEFINED association', async () => {
  const { fetchFn } = makeFetch([
    {
      match: '/labels',
      json: {
        results: [
          { category: 'HUBSPOT_DEFINED', typeId: 279, label: null },
          { category: 'USER_DEFINED', typeId: 42, label: 'Partner' },
        ],
      },
    },
  ]);
  const type = await resolveType({ fromType: 'contacts', toType: 'companies', label: 'default' }, { ...ctxBase, fetchFn });
  assert.deepEqual(type, { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 });
});

test('a failed batch is counted and does not throw', async () => {
  const { fetchFn } = makeFetch([{ match: '/batch/create', ok: false, status: 400, text: 'bad input' }]);
  const out = await batchCreate(
    { fromType: 'contacts', toType: 'companies', pairs: [{ from: '1', to: '2' }], type: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 } },
    { ...ctxBase, fetchFn }
  );
  assert.equal(out.failed, 1);
  assert.equal(out.errors[0].status, 400);
});
