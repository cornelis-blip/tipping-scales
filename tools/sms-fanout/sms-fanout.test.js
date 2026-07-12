/**
 * Tests for sms-fanout — run with:  node --test
 *
 * No dependencies to install: uses only Node's built-in test runner and a fake
 * `fetch` injected via the handler's `deps` arg. Node 18+ required.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handler, _internal } = require('./sms-fanout');

const baseEvent = {
  From: '+15551234567',
  To: '+15559876543',
  Body: 'Yes, that works for me',
  MessageSid: 'SM_test_123',
  NumMedia: '0',
};

/** Build a fake fetch that records calls and returns scripted responses. */
function makeFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const match = handlers.find((h) => url.includes(h.match));
    if (!match) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    if (match.throw) throw new Error(match.throw);
    return {
      ok: match.ok ?? true,
      status: match.status ?? 200,
      text: async () => match.text ?? '',
      json: async () => match.json ?? {},
    };
  };
  return { fetchFn, calls };
}

function run(context, deps) {
  return new Promise((resolve) => {
    handler(context, baseEvent, (err, response) => resolve({ err, response }), deps);
  });
}

test('fans out to every configured webhook in parallel', async () => {
  const { fetchFn, calls } = makeFetch([]);
  await run({ FANOUT_WEBHOOK_URLS: 'https://a.example/hook, https://b.example/hook' }, { fetch: fetchFn });

  const posted = calls.map((c) => c.url);
  assert.ok(posted.includes('https://a.example/hook'));
  assert.ok(posted.includes('https://b.example/hook'));
  // Payload is a faithful replay of the Twilio form fields.
  assert.match(calls[0].opts.body, /From=%2B15551234567/);
  assert.match(calls[0].opts.body, /Body=Yes/);
});

test('one failing destination does not block the others, and Twilio still gets 200', async () => {
  const { fetchFn, calls } = makeFetch([{ match: 'a.example', throw: 'network down' }]);
  const { response } = await run(
    { FANOUT_WEBHOOK_URLS: 'https://a.example/hook, https://b.example/hook' },
    { fetch: fetchFn }
  );

  // Both were attempted...
  assert.equal(calls.length, 2);
  // ...and Twilio still receives an empty TwiML response (no retry / double-delivery).
  assert.equal(response, '<Response></Response>');
});

test('HubSpot api mode logs a Note on the matched contact', async () => {
  const { fetchFn, calls } = makeFetch([
    { match: '/contacts/search', json: { results: [{ id: '801' }] } },
    { match: '/objects/notes', json: { id: 'note_9' } },
  ]);

  await run(
    { HUBSPOT_MODE: 'api', HUBSPOT_PRIVATE_APP_TOKEN: 'pat-test' },
    { fetch: fetchFn, now: 1_700_000_000_000 }
  );

  const note = calls.find((c) => c.url.includes('/objects/notes'));
  assert.ok(note, 'a note should be created');
  const payload = JSON.parse(note.opts.body);
  assert.equal(payload.associations[0].to.id, '801');
  assert.match(payload.properties.hs_note_body, /Yes, that works/);
});

test('HubSpot api mode skips cleanly when no contact matches', async () => {
  const { fetchFn, calls } = makeFetch([{ match: '/contacts/search', json: { results: [] } }]);
  const { response } = await run(
    { HUBSPOT_MODE: 'api', HUBSPOT_PRIVATE_APP_TOKEN: 'pat-test' },
    { fetch: fetchFn }
  );

  assert.ok(!calls.some((c) => c.url.includes('/objects/notes')), 'no note when no contact');
  assert.equal(response, '<Response></Response>');
});

test('rejects malformed inbound payloads with 400', async () => {
  const { fetchFn } = makeFetch([]);
  const bad = { From: '+15551234567' }; // missing To, Body, MessageSid
  const { response } = await new Promise((resolve) => {
    handler({ FANOUT_WEBHOOK_URLS: 'https://a.example/hook' }, bad, (err, r) => resolve({ err, response: r }), {
      fetch: fetchFn,
    });
  });
  assert.equal(response.statusCode, 400);
});

test('normalizePhone keeps the last N digits', () => {
  assert.equal(_internal.normalizePhone('+1 (555) 123-4567'), '5551234567');
  assert.equal(_internal.parseWebhookList('a, b ,, c').length, 3);
});
