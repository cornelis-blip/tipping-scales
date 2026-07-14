/**
 * Tests for the webhook handler (Operations-Hub-free path). Run with:  node --test
 * No install: Node's built-in runner + injected fake fetch. Node 18+.
 *
 * These cover the deterministic logic (payload parsing, secret check, end-to-end
 * handling with a fake fetch). They do NOT assert live Conversations API behaviour
 * or live HubSpot webhook delivery — verify those against a real portal (see README).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWebhookPayload,
  verifySharedSecret,
  handleWebhook,
} = require('./webhook-handler');

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

test('parseWebhookPayload prefers flat top-level keys', () => {
  const p = parseWebhookPayload({ threadId: ' T1 ', ticketId: '99', message: 'hi', fromUserId: '42' });
  assert.deepEqual(p, { threadId: 'T1', ticketId: '99', message: 'hi', fromUserId: '42' });
});

test('parseWebhookPayload falls back to properties map + objectId', () => {
  const p = parseWebhookPayload({
    objectId: 555,
    properties: {
      auto_reply_message: { value: 'Thanks, tracking on the way' },
      auto_reply_from_user_id: '42',
    },
  });
  assert.equal(p.ticketId, '555');
  assert.equal(p.message, 'Thanks, tracking on the way');
  assert.equal(p.fromUserId, '42');
  assert.equal(p.threadId, '');
});

test('parseWebhookPayload applies defaults when fields are absent', () => {
  const p = parseWebhookPayload({ threadId: 'T1', message: 'x' }, { defaults: { fromUserId: '7' } });
  assert.equal(p.fromUserId, '7');
});

test('verifySharedSecret: open when unset, matches case-insensitive header, rejects mismatch', () => {
  assert.equal(verifySharedSecret({}, ''), true);
  assert.equal(verifySharedSecret({ 'X-Webhook-Secret': 's3cret' }, 's3cret'), true);
  assert.equal(verifySharedSecret({ 'x-webhook-secret': 'nope' }, 's3cret'), false);
  assert.equal(verifySharedSecret({}, 's3cret'), false);
});

test('handleWebhook sends a reply and returns the CCA output shape', async () => {
  const { fetchFn, calls } = makeFetch([
    {
      match: (u, o) => u.includes('/messages') && (o?.method || 'GET') === 'GET',
      json: { results: [{ type: 'MESSAGE', channelId: '1002', channelAccountId: '555', subject: 'Order', senders: [{ deliveryIdentifier: { type: 'HS_EMAIL_ADDRESS', value: 'c@x.com' } }] }] },
    },
    { match: (u, o) => u.includes('/messages') && o?.method === 'POST', json: { id: 'msg_7' } },
  ]);

  const out = await handleWebhook(
    { threadId: 'T9', message: 'Reply body', fromUserId: '42' },
    { token: 'pat-test', fetchFn }
  );
  assert.deepEqual(out, { sent: 'true', messageId: 'msg_7', errorCode: '' });

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.senderActorId, 'A-42');
  assert.equal(post.body.channelId, '1002');
  assert.equal(post.body.subject, 'Re: Order');
});

test('handleWebhook resolves threadId from ticketId when not supplied', async () => {
  const { fetchFn, calls } = makeFetch([
    { match: (u) => u.includes('/associations/conversation'), json: { results: [{ toObjectId: 'T-from-ticket' }] } },
    { match: (u, o) => u.includes('/messages') && (o?.method || 'GET') === 'GET', json: { results: [{ type: 'MESSAGE', channelId: '1', channelAccountId: '2' }] } },
    { match: (u, o) => u.includes('/messages') && o?.method === 'POST', json: { id: 'msg_8' } },
  ]);

  const out = await handleWebhook(
    { ticketId: '12345', message: 'hi', fromUserId: '42' },
    { token: 'pat-test', fetchFn }
  );
  assert.equal(out.sent, 'true');
  assert.ok(calls.some((c) => c.url.includes('/threads/T-from-ticket/messages')), 'used resolved thread id');
});

test('handleWebhook returns an errorCode (not throw) when message is missing', async () => {
  const { fetchFn } = makeFetch([]);
  const out = await handleWebhook({ threadId: 'T1', fromUserId: '42' }, { token: 'pat-test', fetchFn });
  assert.equal(out.sent, 'false');
  assert.equal(out.errorCode, 'ERROR');
});

test('handleWebhook surfaces missing token as an error', async () => {
  const out = await handleWebhook({ threadId: 'T1', message: 'x', fromUserId: '1' }, { token: '' });
  assert.equal(out.sent, 'false');
  assert.equal(out.errorCode, 'ERROR');
});
