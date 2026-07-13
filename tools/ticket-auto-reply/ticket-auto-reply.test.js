/**
 * Tests for ticket-auto-reply core. Run with:  node --test
 * No install: Node's built-in runner + injected fake fetch. Node 18+.
 *
 * These cover the deterministic logic (actor id, context derivation, payload
 * shape, error handling). They do NOT assert live Conversations API behaviour —
 * that has to be verified against a real portal (see README).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAgentActorId,
  deriveReplyContext,
  sendReply,
  autoReply,
  _internal,
} = require('./ticket-auto-reply');

const ctxBase = { token: 'pat-test' };

function makeFetch(handlers = []) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    const h = handlers.find((x) => x.match(url, opts)) || {};
    return {
      ok: h.ok ?? true,
      status: h.status ?? 200,
      text: async () => h.text ?? '',
      json: async () => h.json ?? {},
    };
  };
  return { fetchFn, calls };
}

test('buildAgentActorId normalises to A-<id> and rejects empty', () => {
  assert.equal(buildAgentActorId('3892666'), 'A-3892666');
  assert.equal(buildAgentActorId('A-3892666'), 'A-3892666');
  assert.throws(() => buildAgentActorId(''), /required/);
});

test('deriveReplyContext pulls channel, adds Re:, maps senders to recipients', () => {
  const ctx = deriveReplyContext({
    channelId: '1002',
    channelAccountId: '555',
    subject: 'Help with billing',
    senders: [{ actorId: 'V-1', name: 'Jane', deliveryIdentifier: { type: 'HS_EMAIL_ADDRESS', value: 'jane@x.com' } }],
  });
  assert.equal(ctx.channelId, '1002');
  assert.equal(ctx.channelAccountId, '555');
  assert.equal(ctx.subject, 'Re: Help with billing');
  assert.equal(ctx.recipients[0].deliveryIdentifier.value, 'jane@x.com');
});

test('deriveReplyContext does not double-prefix an existing Re:', () => {
  assert.equal(deriveReplyContext({ subject: 'Re: hi' }).subject, 'Re: hi');
});

test('sendReply posts to the thread with senderActorId and strips undefined fields', async () => {
  const { fetchFn, calls } = makeFetch([{ match: (u) => u.includes('/messages'), json: { id: 'msg_1' } }]);
  const out = await sendReply(
    { threadId: 'T1', text: 'Thanks, we are on it.', senderActorId: 'A-99', channelId: '1002', channelAccountId: '555' },
    { ...ctxBase, fetchFn }
  );
  assert.equal(out.id, 'msg_1');
  assert.match(calls[0].url, /\/conversations\/v3\/conversations\/threads\/T1\/messages$/);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.senderActorId, 'A-99');
  assert.equal(calls[0].body.type, 'MESSAGE');
  assert.equal(calls[0].body.richText, '<p>Thanks, we are on it.</p>');
  assert.ok(!('recipients' in calls[0].body), 'undefined fields removed');
});

test('sendReply surfaces a non-OK status as an error with detail', async () => {
  const { fetchFn } = makeFetch([
    { match: (u) => u.includes('/messages'), ok: false, status: 400, text: 'Channel not eligible' },
  ]);
  await assert.rejects(
    () => sendReply({ threadId: 'T1', text: 'hi', senderActorId: 'A-1' }, { ...ctxBase, fetchFn }),
    /send failed: 400/
  );
});

test('autoReply reads the latest message then sends on the same channel', async () => {
  const { fetchFn, calls } = makeFetch([
    {
      match: (u, o) => u.includes('/messages') && (o?.method || 'GET') === 'GET',
      json: {
        results: [
          { type: 'MESSAGE', channelId: '1002', channelAccountId: '555', subject: 'Order', senders: [{ deliveryIdentifier: { type: 'HS_EMAIL_ADDRESS', value: 'c@x.com' } }] },
        ],
      },
    },
    { match: (u, o) => u.includes('/messages') && o?.method === 'POST', json: { id: 'msg_2' } },
  ]);

  const out = await autoReply({ threadId: 'T9', text: 'Reply body', fromUserId: '42' }, { ...ctxBase, fetchFn });
  assert.equal(out.id, 'msg_2');

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.senderActorId, 'A-42');
  assert.equal(post.body.channelId, '1002');
  assert.equal(post.body.subject, 'Re: Order');
  assert.equal(post.body.recipients[0].deliveryIdentifier.value, 'c@x.com');
});

test('escapeHtml neutralises angle brackets in the fallback richText', () => {
  assert.equal(_internal.escapeHtml('a <b> & c'), 'a &lt;b&gt; &amp; c');
});
