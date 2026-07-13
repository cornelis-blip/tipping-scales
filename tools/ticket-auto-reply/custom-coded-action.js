/**
 * HubSpot custom coded action — auto-reply on a ticket's conversation thread.
 *
 * Drop this into a ticket-based workflow to send an automated reply into the
 * ticket's conversation, with no agent review step. Single-file (custom coded
 * actions can't `require` local files); the reusable/tested version is
 * ticket-auto-reply.js.
 *
 * ⚠️ VALID AS OF 2026-07. HubSpot is changing the Conversations API for Help Desk
 *    threads on 2026-09-23 — expect to rework this around then. See the tool README.
 * ⚠️ Auto-sending without a human in the loop is risky. Gate enrolment tightly.
 *
 * ── Configure ─────────────────────────────────────────────────────────────
 *   Input fields:
 *     threadId    (recommended) the conversation thread id to reply on
 *     ticketId    (optional) enrolled ticket id — used only if threadId is blank
 *     message     the reply text to send
 *     fromUserId  HubSpot user id to send AS (reply goes out as agent A-<userId>)
 *   Output fields: sent (enumeration true/false), messageId, errorCode
 *   Secret: CONVERSATIONS_TOKEN — private app token with conversations read/write
 * ───────────────────────────────────────────────────────────────────────────
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

const API = 'https://api.hubapi.com';
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

exports.main = async (event, callback) => {
  const token = process.env.CONVERSATIONS_TOKEN;
  const message = event.inputFields.message;
  const fromUserId = String(event.inputFields.fromUserId || '').trim();
  let threadId = String(event.inputFields.threadId || '').trim();
  const ticketId = String(event.inputFields.ticketId || event.object.objectId || '').trim();

  const out = { sent: 'false', messageId: '', errorCode: '' };

  try {
    if (!token) throw new Error('CONVERSATIONS_TOKEN secret is missing');
    if (!message) throw new Error('message is required');
    if (!fromUserId) throw new Error('fromUserId is required (reply is sent as agent A-<userId>)');

    // Resolve thread id if not supplied. VERIFY this association in your portal;
    // if it doesn't resolve, map threadId in as an input instead.
    if (!threadId && ticketId) {
      const assoc = await api(`/crm/v4/objects/tickets/${ticketId}/associations/conversation`, { token });
      if (assoc.ok) {
        const first = ((await assoc.json()).results || [])[0];
        if (first) threadId = String(first.toObjectId);
      }
    }
    if (!threadId) throw new Error('no threadId (pass threadId, or verify the ticket→conversation association)');

    // Derive channel + recipients from the latest message so the reply threads correctly.
    const msgs = await api(`/conversations/v3/conversations/threads/${threadId}/messages`, { token });
    if (!msgs.ok) throw Object.assign(new Error(`fetch messages ${msgs.status}`), { status: msgs.status });
    const results = (await msgs.json()).results || [];
    const latest = results.filter((m) => m.type === 'MESSAGE').slice(-1)[0] || results.slice(-1)[0] || {};

    const subject = latest.subject
      ? /^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`
      : undefined;
    const recipients = (latest.senders || [])
      .filter((s) => s.deliveryIdentifier || s.actorId)
      .map((s) => ({ actorId: s.actorId, name: s.name, deliveryIdentifier: s.deliveryIdentifier }));

    const body = {
      type: 'MESSAGE',
      text: message,
      richText: `<p>${escapeHtml(message)}</p>`,
      senderActorId: fromUserId.startsWith('A-') ? fromUserId : `A-${fromUserId}`,
      channelId: latest.channelId,
      channelAccountId: latest.channelAccountId,
      subject,
      recipients: recipients.length ? recipients : undefined,
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

    const send = await api(`/conversations/v3/conversations/threads/${threadId}/messages`, {
      method: 'POST',
      token,
      body,
    });
    if (!send.ok) {
      const detail = await send.text().catch(() => '');
      console.error(`[ticket-auto-reply] send ${send.status}: ${detail}`);
      out.errorCode = `HTTP_${send.status}`;
      return callback({ outputFields: out });
    }

    out.sent = 'true';
    out.messageId = String((await send.json()).id || '');
    return callback({ outputFields: out });
  } catch (err) {
    console.error('[ticket-auto-reply] error:', err.message);
    out.errorCode = err.status ? `HTTP_${err.status}` : 'ERROR';
    return callback({ outputFields: out });
  }
};
