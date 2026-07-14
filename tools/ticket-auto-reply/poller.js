/**
 * ticket-auto-reply — external poller (genuinely NO Data Hub / Operations Hub).
 *
 * Both in-workflow routes need Data Hub Professional/Enterprise: the custom coded
 * action AND the "Send a webhook" action are gated behind it. The only way to do
 * this on Service Hub alone is to stop using a workflow trigger entirely and run
 * the logic OUTSIDE HubSpot on a schedule.
 *
 * This is that path. Run it on cron (every N minutes) anywhere — a tiny VM, a
 * scheduled Lambda, GitHub Actions, a Cloudflare Cron Trigger. It:
 *   1. searches the CRM for tickets matching your criteria that haven't been
 *      auto-replied yet (a marker property is how we dedupe — a workflow would
 *      normally handle this via enrolment),
 *   2. resolves each ticket's conversation thread and posts the reply as an agent
 *      (reusing ticket-auto-reply.js),
 *   3. stamps a marker property so the next run skips it.
 *
 * A private app token is available on ALL HubSpot tiers, so nothing here needs
 * Data Hub. What you DO own instead of HubSpot: scheduling, dedupe, and enrolment
 * logic. That's the trade.
 *
 * ⚠️ VALID AS OF 2026-07. HubSpot is changing the Conversations API for Help Desk
 *    threads on 2026-09-23 — expect to rework this around then. See the tool README.
 * ⚠️ Auto-sending without a human in the loop is risky. Keep the search filter tight
 *    and start with DRY_RUN=1. There is no "undo" on a sent message.
 *
 * ── Env (see .env.example) ──────────────────────────────────────────────────
 *   CONVERSATIONS_TOKEN   private app token: conversations read+write, tickets
 *                         read+write (write needed to stamp the marker property)
 *   FROM_USER_ID          HubSpot user id to send AS (reply goes out as A-<id>)
 *   REPLY_MESSAGE         the reply text to send
 *   MARKER_PROPERTY       ticket property used to dedupe (default: auto_reply_sent_at).
 *                         Create it in your portal first (single-line text / datetime).
 *   PIPELINE_STAGE_ID     (optional) only reply to tickets in this stage
 *   MAX_PER_RUN           (optional) safety cap on replies per run (default 25)
 *   DRY_RUN               (optional) "1" to scan + log without sending. START HERE.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const { autoReply, resolveThreadIdForTicket } = require('./ticket-auto-reply');

const API = 'https://api.hubapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', token, body, fetchFn = fetch } = {}) {
  return fetchFn(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Build a CRM ticket search body. The core filter is "marker property not set"
 * (NOT_HAS_PROPERTY) so we never reply twice; extra filters narrow enrolment.
 * Keep this TIGHT — it's the only thing standing between you and mass auto-replies.
 */
function buildSearchRequest({ markerProperty, pipelineStageId, extraFilters = [], limit = 50, after } = {}) {
  const filters = [{ propertyName: markerProperty, operator: 'NOT_HAS_PROPERTY' }];
  if (pipelineStageId) filters.push({ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: pipelineStageId });
  filters.push(...extraFilters);
  return {
    filterGroups: [{ filters }],
    properties: ['subject', 'hs_pipeline_stage', markerProperty],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    limit,
    after,
  };
}

/** One page of matching tickets. Returns { results, after }. */
async function searchTickets(config, ctx) {
  const body = buildSearchRequest(config);
  const res = await api('/crm/v3/objects/tickets/search', { method: 'POST', body, ...ctx });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`ticket search failed: ${res.status}`), { status: res.status, detail });
  }
  const json = await res.json();
  return { results: json.results || [], after: json.paging?.next?.after };
}

/** Stamp the marker property so the next run skips this ticket. */
async function markReplied(ticketId, { markerProperty, value }, ctx) {
  const res = await api(`/crm/v3/objects/tickets/${ticketId}`, {
    method: 'PATCH',
    body: { properties: { [markerProperty]: value } },
    ...ctx,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`mark failed: ${res.status}`), { status: res.status, detail });
  }
  return true;
}

/**
 * Process a single ticket: resolve thread → reply → mark. Returns a result row.
 * Never throws — failures are captured so one bad ticket doesn't stop the run.
 */
async function processTicket(ticket, { message, fromUserId, markerProperty, dryRun, now }, ctx) {
  const ticketId = String(ticket.id);
  try {
    const threadId = await resolveThreadIdForTicket(ticketId, ctx);
    if (!threadId) return { ticketId, status: 'skipped', reason: 'no thread resolved' };

    if (dryRun) return { ticketId, threadId, status: 'dry-run' };

    const sent = await autoReply({ threadId, text: message, fromUserId }, ctx);
    // Mark AFTER a confirmed send. Worst case on a mark failure is a duplicate
    // reply next run — loud (logged) and rare, versus silently never marking.
    await markReplied(ticketId, { markerProperty, value: now() }, ctx);
    return { ticketId, threadId, status: 'replied', messageId: String(sent.id || '') };
  } catch (err) {
    console.error(`[ticket-auto-reply:poller] ticket ${ticketId}: ${err.message}`);
    return { ticketId, status: 'failed', errorCode: err.status ? `HTTP_${err.status}` : 'ERROR' };
  }
}

/**
 * Run one poll cycle across all pages, up to maxPerRun replies.
 * Returns a summary { scanned, replied, skipped, failed, dryRun, capped, results }.
 */
async function runPoll(config, ctx) {
  const {
    message,
    fromUserId,
    markerProperty = 'auto_reply_sent_at',
    pipelineStageId,
    extraFilters,
    maxPerRun = 25,
    dryRun = false,
    now = () => new Date().toISOString(),
    pageDelayMs = 200,
  } = config;

  if (!message) throw new Error('message (REPLY_MESSAGE) is required');
  if (!fromUserId) throw new Error('fromUserId (FROM_USER_ID) is required — reply sends as agent A-<id>');

  const results = [];
  let after;
  let acted = 0;
  let capped = false;

  do {
    const page = await searchTickets(
      { markerProperty, pipelineStageId, extraFilters, limit: 50, after },
      ctx
    );
    for (const ticket of page.results) {
      if (acted >= maxPerRun) {
        capped = true;
        break;
      }
      const row = await processTicket(ticket, { message, fromUserId, markerProperty, dryRun, now }, ctx);
      results.push(row);
      if (row.status === 'replied' || row.status === 'dry-run') acted++;
    }
    after = capped ? undefined : page.after;
    if (after) await sleep(pageDelayMs);
  } while (after);

  const summary = {
    scanned: results.length,
    replied: results.filter((r) => r.status === 'replied').length,
    dryRun: results.filter((r) => r.status === 'dry-run').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    capped,
    results,
  };
  if (capped) console.warn(`[ticket-auto-reply:poller] hit maxPerRun=${maxPerRun}; more tickets remain for next run`);
  return summary;
}

/** Build config from environment and run one cycle. */
async function runFromEnv(env = process.env) {
  const token = env.CONVERSATIONS_TOKEN;
  if (!token) throw new Error('CONVERSATIONS_TOKEN is missing');
  return runPoll(
    {
      message: env.REPLY_MESSAGE,
      fromUserId: env.FROM_USER_ID,
      markerProperty: env.MARKER_PROPERTY || 'auto_reply_sent_at',
      pipelineStageId: env.PIPELINE_STAGE_ID || undefined,
      maxPerRun: env.MAX_PER_RUN ? Number(env.MAX_PER_RUN) : 25,
      dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    },
    { token }
  );
}

module.exports = {
  buildSearchRequest,
  searchTickets,
  markReplied,
  processTicket,
  runPoll,
  runFromEnv,
};

// CLI: `node poller.js` runs one cycle from env. Wire this into cron / a scheduler.
if (require.main === module) {
  runFromEnv()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[ticket-auto-reply:poller] fatal:', err.message);
      process.exit(1);
    });
}
