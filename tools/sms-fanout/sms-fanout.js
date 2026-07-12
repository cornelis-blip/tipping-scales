/**
 * sms-fanout — broadcast one inbound Twilio SMS to many destinations.
 *
 * The problem this solves:
 *   A Twilio phone number can POST inbound messages to exactly ONE webhook. So
 *   if you want both HubSpot *and* a shared inbox / helpdesk (Front, Zendesk,
 *   Help Scout…) to see every reply, one of them is always blind.
 *
 * The fix:
 *   Point the number at this Function instead. It fans the inbound message out
 *   to every destination in parallel and always returns an empty 200 to Twilio,
 *   so a slow or failing destination never causes Twilio to retry and
 *   double-deliver.
 *
 * Destinations (configure via environment variables):
 *   1. FANOUT_WEBHOOK_URLS  — comma-separated list of webhooks. Each receives a
 *      faithful replay of the original Twilio form payload, so any tool that
 *      already accepts a Twilio SMS webhook (including HubSpot's own inbound
 *      Twilio webhook) works with zero changes.
 *   2. HubSpot timeline (optional) — set HUBSPOT_MODE=api to also look up the
 *      contact by phone number and log the reply as a Note on their timeline.
 *
 * Deployment note:
 *   This is deliberately ONE self-contained file. Twilio Functions resolve
 *   sibling files through `Runtime.getFunctions()`, not plain `require('./x')`,
 *   which trips people up constantly — so everything is inlined. Upload it as a
 *   single Public function and point your number's "A message comes in" at it.
 *
 * Testability:
 *   The handler takes an optional `deps` arg ({ fetch }) so it can be unit
 *   tested without real HTTP. See sms-fanout.test.js.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

// ─── Payload helpers ─────────────────────────────────────────────────────────

const TWILIO_FIELDS = ['From', 'To', 'Body', 'MessageSid', 'AccountSid', 'NumMedia'];

/** Rebuild the original Twilio form body (incl. any MMS media) for replay. */
function buildFormBody(event) {
  const params = new URLSearchParams();
  for (const field of TWILIO_FIELDS) {
    if (event[field] !== undefined) params.append(field, event[field]);
  }
  const numMedia = parseInt(event.NumMedia || '0', 10);
  for (let i = 0; i < numMedia; i++) {
    if (event[`MediaUrl${i}`]) params.append(`MediaUrl${i}`, event[`MediaUrl${i}`]);
    if (event[`MediaContentType${i}`]) {
      params.append(`MediaContentType${i}`, event[`MediaContentType${i}`]);
    }
  }
  return params.toString();
}

/** Replay the raw Twilio payload to one webhook. Never throws. */
async function replayToWebhook(url, event, fetchFn) {
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildFormBody(event),
    });
    if (response.ok) return { url, ok: true, status: response.status };
    const body = await response.text().catch(() => '');
    return { url, ok: false, status: response.status, body };
  } catch (err) {
    return { url, ok: false, error: err.message };
  }
}

// ─── Optional HubSpot timeline logging ───────────────────────────────────────

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const CONTACT_TO_NOTE_ASSOCIATION = 202; // HUBSPOT_DEFINED contact ↔ note

/** Keep the last `len` digits — a pragmatic default for matching stored numbers. */
function normalizePhone(raw, len = 10) {
  return String(raw || '').replace(/\D/g, '').slice(-len);
}

async function searchContactByPhone(phone, token, fetchFn) {
  const response = await fetchFn(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      limit: 1,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`contact search failed: ${response.status}`), {
      status: response.status,
      body: text,
    });
  }
  const data = await response.json();
  return data.results?.[0] || null;
}

async function createNote(contactId, event, token, fetchFn, now) {
  const response = await fetchFn(`${HUBSPOT_API_BASE}/crm/v3/objects/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      properties: {
        hs_note_body: `SMS reply received\nFrom: ${event.From}\nTo: ${event.To}\nMessage: ${event.Body}`,
        hs_timestamp: String(now),
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: CONTACT_TO_NOTE_ASSOCIATION,
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`note creation failed: ${response.status}`), {
      status: response.status,
      body: text,
    });
  }
  return (await response.json()).id;
}

/**
 * Log the inbound SMS as a Note on the matching contact. Never throws — a
 * missing contact is a normal skip, not an error.
 */
async function logToHubSpot(event, context, fetchFn, now) {
  const token = context.HUBSPOT_PRIVATE_APP_TOKEN;
  const countryCode = context.HUBSPOT_PHONE_COUNTRY_CODE || '1';
  try {
    const local = normalizePhone(event.From);
    // Try the bare local number first, then with the country code prefix.
    const contact =
      (await searchContactByPhone(local, token, fetchFn)) ||
      (await searchContactByPhone(`+${countryCode}${local}`, token, fetchFn));

    if (!contact) return { target: 'hubspot', ok: true, skipped: true, reason: 'no-matching-contact' };

    const noteId = await createNote(contact.id, event, token, fetchFn, now);
    return { target: 'hubspot', ok: true, status: 201, noteId, contactId: contact.id };
  } catch (err) {
    return { target: 'hubspot', ok: false, status: err.status, error: err.message };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['From', 'To', 'Body', 'MessageSid'];

function parseWebhookList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Twilio Function entry point.
 * @param {object}   context  Twilio env vars (FANOUT_WEBHOOK_URLS, HUBSPOT_MODE, …)
 * @param {object}   event    Twilio inbound SMS fields (From, To, Body, …)
 * @param {function} callback Twilio callback(err, response)
 * @param {object}   [deps]   { fetch, now } — injected for testing
 */
exports.handler = async function handler(context, event, callback, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || Date.now();

  const missing = REQUIRED_FIELDS.filter((f) => !event[f]);
  if (missing.length > 0) {
    console.error(`[sms-fanout] Missing required fields: ${missing.join(', ')}`);
    return callback(null, { statusCode: 400, body: `Missing fields: ${missing.join(', ')}` });
  }

  const tasks = parseWebhookList(context.FANOUT_WEBHOOK_URLS).map((url) =>
    replayToWebhook(url, event, fetchFn)
  );
  if (context.HUBSPOT_MODE === 'api') {
    tasks.push(logToHubSpot(event, context, fetchFn, now));
  }

  if (tasks.length === 0) {
    console.warn('[sms-fanout] No destinations configured — set FANOUT_WEBHOOK_URLS.');
  }

  // allSettled: one destination failing must never block the others, and Twilio
  // must still get a 200 so it does not retry and double-deliver.
  const settled = await Promise.allSettled(tasks);
  const results = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { ok: false, error: s.reason?.message }
  );
  console.log(`[sms-fanout] results: ${JSON.stringify(results)}`);

  /* global Twilio */
  const twiml =
    typeof Twilio !== 'undefined' ? new Twilio.twiml.MessagingResponse() : '<Response></Response>';
  return callback(null, twiml);
};

// Exported for testing.
exports._internal = { buildFormBody, normalizePhone, parseWebhookList, replayToWebhook, logToHubSpot };
