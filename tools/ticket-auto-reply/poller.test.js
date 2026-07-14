/**
 * Tests for the external poller (no-Data-Hub path). Run with:  node --test
 * No install: Node's built-in runner + injected fake fetch. Node 18+.
 *
 * These cover the deterministic logic (search request shape, dedupe marker,
 * per-ticket flow, dry-run, the maxPerRun cap, error isolation). They do NOT
 * assert live CRM/Conversations behaviour — verify that against a real portal.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSearchRequest,
  processTicket,
  runPoll,
} = require('./poller');

const ctxBase = { token: 'pat-test' };
const NOW = '2026-07-14T00:00:00.000Z';
const now = () => NOW;

/**
 * Fake fetch driven by ordered handlers. Each handler matches on (url, method)
 * and supplies json/status. Records calls for assertions.
 */
function makeFetch(handlers = []) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const method = opts?.method || 'GET';
    calls.push({ url, method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    const h = handlers.find((x) => x.match(url, method)) || {};
    return {
      ok: h.ok ?? true,
      status: h.status ?? 200,
      text: async () => h.text ?? '',
      json: async () => h.json ?? {},
    };
  };
  return { fetchFn, calls };
}

// Handlers for the reply sub-flow (association lookup + GET messages + POST reply).
const replyOk = (threadId = 'T-1', messageId = 'msg_1') => [
  { match: (u) => u.includes('/associations/conversation'), json: { results: [{ toObjectId: threadId }] } },
  { match: (u, m) => u.includes('/messages') && m === 'GET', json: { results: [{ type: 'MESSAGE', channelId: '1', channelAccountId: '2' }] } },
  { match: (u, m) => u.includes('/messages') && m === 'POST', json: { id: messageId } },
];

test('buildSearchRequest dedupes on NOT_HAS_PROPERTY and adds stage filter', () => {
  const body = buildSearchRequest({ markerProperty: 'auto_reply_sent_at', pipelineStageId: '3' });
  const filters = body.filterGroups[0].filters;
  assert.deepEqual(filters[0], { propertyName: 'auto_reply_sent_at', operator: 'NOT_HAS_PROPERTY' });
  assert.deepEqual(filters[1], { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '3' });
  assert.ok(body.properties.includes('auto_reply_sent_at'));
});

test('buildSearchRequest omits stage filter when none given', () => {
  const body = buildSearchRequest({ markerProperty: 'm' });
  assert.equal(body.filterGroups[0].filters.length, 1);
});

test('processTicket replies then stamps the marker property', async () => {
  const { fetchFn, calls } = makeFetch(replyOk('T-9', 'msg_9'));
  const row = await processTicket(
    { id: '555' },
    { message: 'hi', fromUserId: '42', markerProperty: 'auto_reply_sent_at', dryRun: false, now },
    { ...ctxBase, fetchFn }
  );
  assert.equal(row.status, 'replied');
  assert.equal(row.messageId, 'msg_9');

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /\/crm\/v3\/objects\/tickets\/555$/);
  assert.equal(patch.body.properties.auto_reply_sent_at, NOW);
});

test('processTicket dry-run neither sends nor marks', async () => {
  const { fetchFn, calls } = makeFetch(replyOk());
  const row = await processTicket(
    { id: '1' },
    { message: 'hi', fromUserId: '42', markerProperty: 'm', dryRun: true, now },
    { ...ctxBase, fetchFn }
  );
  assert.equal(row.status, 'dry-run');
  assert.ok(!calls.some((c) => c.method === 'POST'), 'no reply sent');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no marker stamped');
});

test('processTicket skips when no thread resolves', async () => {
  const { fetchFn } = makeFetch([
    { match: (u) => u.includes('/associations/conversation'), json: { results: [] } },
  ]);
  const row = await processTicket(
    { id: '1' },
    { message: 'hi', fromUserId: '42', markerProperty: 'm', dryRun: false, now },
    { ...ctxBase, fetchFn }
  );
  assert.equal(row.status, 'skipped');
});

test('processTicket captures a send failure without throwing', async () => {
  const { fetchFn } = makeFetch([
    { match: (u) => u.includes('/associations/conversation'), json: { results: [{ toObjectId: 'T1' }] } },
    { match: (u, m) => u.includes('/messages') && m === 'GET', json: { results: [{ type: 'MESSAGE' }] } },
    { match: (u, m) => u.includes('/messages') && m === 'POST', ok: false, status: 400, text: 'Channel not eligible' },
  ]);
  const row = await processTicket(
    { id: '7' },
    { message: 'hi', fromUserId: '42', markerProperty: 'm', dryRun: false, now },
    { ...ctxBase, fetchFn }
  );
  assert.equal(row.status, 'failed');
  assert.equal(row.errorCode, 'HTTP_400');
});

test('runPoll processes a page and summarises', async () => {
  const { fetchFn } = makeFetch([
    { match: (u, m) => u.includes('/tickets/search') && m === 'POST', json: { results: [{ id: '1' }, { id: '2' }] } },
    ...replyOk(),
    { match: (u, m) => u.includes('/crm/v3/objects/tickets/') && m === 'PATCH', json: {} },
  ]);
  const summary = await runPoll(
    { message: 'hi', fromUserId: '42', markerProperty: 'm', now, pageDelayMs: 0 },
    { ...ctxBase, fetchFn }
  );
  assert.equal(summary.scanned, 2);
  assert.equal(summary.replied, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.capped, false);
});

test('runPoll honours maxPerRun and reports capped', async () => {
  const { fetchFn } = makeFetch([
    { match: (u, m) => u.includes('/tickets/search') && m === 'POST', json: { results: [{ id: '1' }, { id: '2' }, { id: '3' }] } },
    ...replyOk(),
    { match: (u, m) => u.includes('/crm/v3/objects/tickets/') && m === 'PATCH', json: {} },
  ]);
  const summary = await runPoll(
    { message: 'hi', fromUserId: '42', markerProperty: 'm', maxPerRun: 2, now, pageDelayMs: 0 },
    { ...ctxBase, fetchFn }
  );
  assert.equal(summary.replied, 2);
  assert.equal(summary.capped, true);
});

test('runPoll requires message and fromUserId', async () => {
  const { fetchFn } = makeFetch([]);
  await assert.rejects(() => runPoll({ fromUserId: '42', now }, { ...ctxBase, fetchFn }), /message/);
  await assert.rejects(() => runPoll({ message: 'hi', now }, { ...ctxBase, fetchFn }), /fromUserId/);
});
