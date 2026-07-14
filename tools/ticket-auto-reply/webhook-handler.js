/**
 * ticket-auto-reply — webhook handler (Operations Hub NOT required).
 *
 * The Operations-Hub-free path. Instead of a custom coded action (which needs
 * Operations Hub Professional/Enterprise), point a Service Hub "Send a webhook"
 * workflow action — available on any Professional hub — at your own endpoint.
 * This handler runs the SAME core logic (resolve thread → read latest message →
 * reply as an agent) using ticket-auto-reply.js, so nothing about the outcome
 * changes; only where the code executes does.
 *
 * ⚠️ VALID AS OF 2026-07. HubSpot is changing the Conversations API for Help Desk
 *    threads on 2026-09-23 — expect to rework this around then. See the tool README.
 * ⚠️ Auto-sending without a human in the loop is risky. Gate enrolment tightly.
 *
 * ── What HubSpot sends ─────────────────────────────────────────────────────
 *   The "Send a webhook" action POSTs JSON. Two shapes are supported:
 *     1. Custom request body (recommended): send flat keys directly —
 *        { "threadId": "...", "ticketId": "...", "message": "...", "fromUserId": "..." }
 *     2. Default object payload: { "objectId": <ticketId>, "properties": { ... } }
 *        — objectId is used as the ticket fallback; message/fromUserId come from
 *        properties you map in, or from the handler defaults below.
 *
 * ── Deploy ─────────────────────────────────────────────────────────────────
 *   Framework-agnostic core: `handleWebhook(payload, ctx)` is a pure async fn you
 *   can wire into anything. Two adapters are included (`lambdaHandler`,
 *   `nodeHandler`); a Cloudflare Worker example is in the README (ESM, so it wraps
 *   this module rather than living here).
 *
 * ── Env ────────────────────────────────────────────────────────────────────
 *   CONVERSATIONS_TOKEN   private app token, conversations read+write (+ tickets
 *                         read if you resolve the thread from a ticket id)
 *   WEBHOOK_SHARED_SECRET (optional) require a matching secret on inbound requests.
 *                         Set the same value as a custom header in the HubSpot action.
 *   DEFAULT_FROM_USER_ID  (optional) fallback agent user id if the payload omits one
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const { autoReply, resolveThreadIdForTicket } = require('./ticket-auto-reply');

/** Read a value from a HubSpot property map, tolerating {value} or raw shapes. */
function prop(properties, key) {
  const v = properties && properties[key];
  if (v == null) return undefined;
  return typeof v === 'object' && 'value' in v ? v.value : v;
}

/**
 * Normalise an inbound webhook body into { threadId, ticketId, message, fromUserId }.
 * Flat top-level keys win; falls back to a HubSpot property map + objectId.
 */
function parseWebhookPayload(payload = {}, { defaults = {} } = {}) {
  const p = payload.properties || {};
  const pick = (flat, propKey, def) => {
    const raw = payload[flat] ?? prop(p, propKey) ?? def;
    return raw == null ? '' : String(raw).trim();
  };
  return {
    threadId: pick('threadId', 'hs_thread_id', ''),
    ticketId: pick('ticketId', 'hs_object_id', payload.objectId),
    message: pick('message', 'auto_reply_message', defaults.message),
    fromUserId: pick('fromUserId', 'auto_reply_from_user_id', defaults.fromUserId),
  };
}

/** Length-safe constant-time-ish string comparison. */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Optional gate: require a shared secret on the inbound request. Configure the
 * same value as a custom header (default: x-webhook-secret) in the HubSpot action.
 * Returns true when no secret is configured (open) or the header matches.
 */
function verifySharedSecret(headers = {}, expected, headerName = 'x-webhook-secret') {
  if (!expected) return true;
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return safeEqual(lower[headerName.toLowerCase()], expected);
}

/**
 * Core handler. Pure-ish: pass in token + fetch, get back the same output shape
 * the custom coded action produces ({ sent, messageId, errorCode }).
 */
async function handleWebhook(payload, { token, fetchFn = fetch, defaultFromUserId } = {}) {
  const out = { sent: 'false', messageId: '', errorCode: '' };
  try {
    if (!token) throw new Error('CONVERSATIONS_TOKEN is missing');

    const { threadId: given, ticketId, message, fromUserId } = parseWebhookPayload(payload, {
      defaults: { fromUserId: defaultFromUserId },
    });
    if (!message) throw new Error('message is required');
    if (!fromUserId) throw new Error('fromUserId is required (reply is sent as agent A-<userId>)');

    // Prefer an explicit threadId; otherwise best-effort resolve from the ticket.
    // VERIFY this association in your portal — if it returns null, map threadId in.
    let threadId = given;
    if (!threadId && ticketId) {
      threadId = await resolveThreadIdForTicket(ticketId, { token, fetchFn });
    }
    if (!threadId) {
      throw new Error('no threadId (send threadId in the webhook body, or verify the ticket→conversation association)');
    }

    const sent = await autoReply({ threadId, text: message, fromUserId }, { token, fetchFn });
    out.sent = 'true';
    out.messageId = String(sent.id || '');
    return out;
  } catch (err) {
    console.error('[ticket-auto-reply:webhook] error:', err.message);
    out.errorCode = err.status ? `HTTP_${err.status}` : 'ERROR';
    return out;
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

/** AWS Lambda / API Gateway (proxy integration) adapter. */
async function lambdaHandler(event = {}) {
  const headers = event.headers || {};
  if (!verifySharedSecret(headers, process.env.WEBHOOK_SHARED_SECRET)) {
    return { statusCode: 401, body: JSON.stringify({ errorCode: 'UNAUTHORISED' }) };
  }
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ errorCode: 'BAD_JSON' }) };
  }
  const out = await handleWebhook(payload, {
    token: process.env.CONVERSATIONS_TOKEN,
    defaultFromUserId: process.env.DEFAULT_FROM_USER_ID,
  });
  // 200 even on a handled failure — HubSpot retries non-2xx; inspect errorCode instead.
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
}

/** Generic Node (req, res) adapter — plain http server, Express, etc. */
async function nodeHandler(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  if (!verifySharedSecret(req.headers, process.env.WEBHOOK_SHARED_SECRET)) {
    return send(401, { errorCode: 'UNAUTHORISED' });
  }
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return send(400, { errorCode: 'BAD_JSON' });
  }
  const out = await handleWebhook(payload, {
    token: process.env.CONVERSATIONS_TOKEN,
    defaultFromUserId: process.env.DEFAULT_FROM_USER_ID,
  });
  return send(200, out);
}

module.exports = {
  parseWebhookPayload,
  verifySharedSecret,
  handleWebhook,
  lambdaHandler,
  nodeHandler,
  _internal: { prop, safeEqual },
};
