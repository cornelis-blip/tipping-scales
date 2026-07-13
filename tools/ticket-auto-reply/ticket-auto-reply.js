/**
 * ticket-auto-reply — send an automated reply into a ticket's conversation thread.
 *
 * What it does:
 *   HubSpot has no native "workflow → send a macro/reply on a ticket" action. This
 *   reproduces the outcome: from a ticket workflow, post a reply into the ticket's
 *   conversation thread via the Conversations API — no agent review step.
 *
 *   You can't literally invoke a Macro object (macros aren't API-addressable), so
 *   this sends the reply text a macro would insert. Pair it with a normal workflow
 *   "set property" step to cover the property side of a macro.
 *
 * ⚠️ TIME-SENSITIVE (as of 2026-07): HubSpot has a breaking change to the
 *   Conversations API for Help Desk-associated threads landing 2026-09-23. This
 *   tool works TODAY but will very likely need reworking around that date — treat
 *   it as "valid as of mid-2026", not evergreen. See README.
 *
 * ⚠️ DANGER: auto-replying without a human in the loop is a foot-gun (wrong tone to
 *   an upset customer, wrong context, deliverability). Gate it with tight workflow
 *   enrolment criteria. See README "Dangers".
 *
 * Host-agnostic core: pure functions taking an injected `fetch`. For a custom coded
 * action (single file, no local requires) copy custom-coded-action.js.
 *
 * Notes on what needs portal verification (can't be hard-coded reliably):
 *   - senderActorId must be an AGENT: format "A-<hubspotUserId>".
 *   - Reply channel/account/recipients are derived from the thread's latest message.
 *   - Resolving a ticket → thread id depends on your portal; prefer passing threadId.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const HUBSPOT_API = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Build a valid AGENT sender actor id ("A-<userId>") from a HubSpot user id. */
function buildAgentActorId(userId) {
  const s = String(userId ?? '').trim();
  if (!s) throw new Error('fromUserId is required — replies must be sent as an agent (A-<userId>)');
  return s.startsWith('A-') ? s : `A-${s}`;
}

/** Fetch the latest real MESSAGE (not comment) on a thread. */
async function getLatestMessage(threadId, { token, fetchFn = fetch }) {
  const res = await withRetry(() =>
    hsFetch(`/conversations/v3/conversations/threads/${threadId}/messages`, { token, fetchFn })
  );
  if (!res.ok) {
    throw Object.assign(new Error(`fetch messages failed: ${res.status}`), { status: res.status });
  }
  const results = (await res.json()).results || [];
  const messages = results.filter((m) => m.type === 'MESSAGE');
  return messages[messages.length - 1] || results[results.length - 1] || null;
}

/**
 * Derive the channel + recipients + subject to reply on, from the thread's latest
 * message — so the reply goes out on the same channel, to the original sender.
 */
function deriveReplyContext(latestMessage) {
  if (!latestMessage) return {};
  const subject = latestMessage.subject
    ? /^re:/i.test(latestMessage.subject)
      ? latestMessage.subject
      : `Re: ${latestMessage.subject}`
    : undefined;

  const recipients = (latestMessage.senders || [])
    .filter((s) => s.deliveryIdentifier || s.actorId)
    .map((s) => ({ actorId: s.actorId, name: s.name, deliveryIdentifier: s.deliveryIdentifier }));

  return {
    channelId: latestMessage.channelId,
    channelAccountId: latestMessage.channelAccountId,
    subject,
    recipients: recipients.length ? recipients : undefined,
  };
}

/** Post a reply message to a thread. Returns the created message. */
async function sendReply(
  { threadId, text, richText, senderActorId, channelId, channelAccountId, subject, recipients },
  { token, fetchFn = fetch }
) {
  const body = {
    type: 'MESSAGE',
    text,
    richText: richText || (text ? `<p>${escapeHtml(text)}</p>` : undefined),
    senderActorId,
    channelId,
    channelAccountId,
    subject,
    recipients,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const res = await withRetry(() =>
    hsFetch(`/conversations/v3/conversations/threads/${threadId}/messages`, {
      method: 'POST',
      token,
      fetchFn,
      body,
    })
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`send failed: ${res.status}`), { status: res.status, detail });
  }
  return res.json();
}

/**
 * Best-effort ticket → thread id. Association specifics vary by portal, so VERIFY
 * this in yours; if it returns null, pass threadId directly instead.
 */
async function resolveThreadIdForTicket(ticketId, { token, fetchFn = fetch }) {
  const res = await withRetry(() =>
    hsFetch(`/crm/v4/objects/tickets/${ticketId}/associations/conversation`, { token, fetchFn })
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const first = ((await res.json()).results || [])[0];
  return first ? String(first.toObjectId) : null;
}

/** Convenience: derive context from the latest message, then send the reply. */
async function autoReply({ threadId, text, richText, fromUserId }, ctx) {
  const senderActorId = buildAgentActorId(fromUserId);
  const latest = await getLatestMessage(threadId, ctx);
  const context = deriveReplyContext(latest);
  return sendReply({ threadId, text, richText, senderActorId, ...context }, ctx);
}

module.exports = {
  buildAgentActorId,
  getLatestMessage,
  deriveReplyContext,
  sendReply,
  resolveThreadIdForTicket,
  autoReply,
  _internal: { escapeHtml, withRetry },
};
