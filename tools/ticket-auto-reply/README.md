# ticket-auto-reply

**Send an automated reply into a ticket's conversation thread from a workflow — the Service Hub automation HubSpot doesn't give you natively.**

> **Valid as of July 2026 — expect to rework this around 2026-09-23.** HubSpot has a breaking
> change to the Conversations API for **Help Desk**-associated threads landing on that date. This
> tool works today, but it is explicitly *not* evergreen. See "The moving target" below.

---

## The gap

HubSpot workflows can't send a reply (or apply a macro) on a ticket automatically — a human has to be
in the loop in the help desk. Macros can *trigger* workflows, but workflows can't *send* a macro.
People have asked HubSpot to add this for years; it's a real Service Hub gap versus other ticketing
tools.

You can't invoke a Macro object via API, but you **can** reproduce the outcome: from a ticket
workflow, post a reply into the ticket's conversation thread via the Conversations API. Pair it with a
normal "set property" workflow step to cover the property side of a macro.

## Dangers — think before you automate this

Auto-replying **without a human reviewing** is the sharp edge, and it's arguably why HubSpot gates it:

- A cheerful canned reply to a furious customer reads as tone-deaf and can escalate.
- Wrong-context or premature replies erode trust fast, at machine speed.
- Deliverability / spam exposure if a loop or bad enrolment fires repeatedly.

If you use this, **gate it hard**: tight enrolment criteria, narrow ticket types, ideally only for
unambiguous cases (e.g. "acknowledge receipt", "send tracking link"), and consider a delay + a
re-check step so a human can intervene. Auto-send is a tool for the 10% of cases that are genuinely
safe to automate, not a blanket replacement for agents.

## The moving target

As of July 2026, HubSpot's changelog flags a breaking change to the Conversations API + Help Desk +
Comments on **2026-09-23** (for Help Desk threads, comment creation via this endpoint starts erroring;
you move to notes). Reply *messages* may be affected differently, but the whole area is in flux.
**Before relying on this in production, re-check the current Conversations API docs** and re-test — and
assume a rework around that date.

## Files

| File | Use it when |
|---|---|
| [`custom-coded-action.js`](custom-coded-action.js) | Workflow-native. Single-file, copy-paste. **Needs Data Hub (Operations Hub) Pro/Enterprise.** |
| [`webhook-handler.js`](webhook-handler.js) | You drive it from a "Send a webhook" workflow action. **Also needs Data Hub Pro/Enterprise** (that action is gated too). Exports `handleWebhook`, `parseWebhookPayload`, `verifySharedSecret`, `lambdaHandler`, `nodeHandler`. |
| [`poller.js`](poller.js) | **The only path that needs no Data Hub.** External scheduled job — no workflow at all. Exports `runPoll`, `runFromEnv`, `searchTickets`, `processTicket`, `buildSearchRequest`, `markReplied`. |
| [`ticket-auto-reply.js`](ticket-auto-reply.js) | Shared core reused by all three. Exports `autoReply`, `sendReply`, `deriveReplyContext`, `getLatestMessage`, `buildAgentActorId`, `resolveThreadIdForTicket`. |

## Subscription requirements — read this before you pick a file

There are two gates, and this trips people up:

- **The ticket workflow itself** needs **Service Hub Professional or Enterprise** (ticket-based workflows).
- **Any in-workflow way to run this** needs **Data Hub Professional/Enterprise** (Data Hub is the current
  name for Operations Hub). This catches **both** `custom-coded-action.js` *and* `webhook-handler.js` —
  the **"Send a webhook" action is gated behind Data Hub too**, per HubSpot's own docs. It is *not*
  available on a bare Sales/Service Pro subscription.

So if you're on **Service Hub Pro without Data Hub**, neither workflow route is available to you. The only
option that avoids Data Hub is to **stop using a workflow trigger** and run [`poller.js`](poller.js) on a
schedule instead. A private app token works on all tiers, so the poller needs no Data Hub licence — the
trade is that *you* now own the scheduling, the dedupe, and the enrolment logic a workflow would handle.

| Route | Needs Service Pro+ | Needs Data Hub Pro+ | You own scheduling/dedupe |
|---|:---:|:---:|:---:|
| `custom-coded-action.js` | ✅ | ✅ | — |
| `webhook-handler.js` | ✅ | ✅ | — |
| `poller.js` | — (any tier with API access) | ❌ **not needed** | ✅ |

## Setup (custom coded action)

1. Paste `custom-coded-action.js` into a ticket-based workflow action.
2. Input fields: **`threadId`** (recommended), **`ticketId`** (fallback), **`message`**,
   **`fromUserId`**.
3. Output fields: **`sent`** (enumeration), **`messageId`**, **`errorCode`**.
4. Secret **`CONVERSATIONS_TOKEN`** — private app token with conversations read + write.

## Setup (webhook — still needs Data Hub, just moves the code out of HubSpot)

Use this if you *have* Data Hub but prefer your logic in your own infra rather than a custom coded action.
It does **not** dodge the Data Hub requirement — the "Send a webhook" action is itself gated.

1. Deploy `webhook-handler.js` to any serverless host (AWS Lambda, Cloudflare Worker, plain Node).
   Set env: **`CONVERSATIONS_TOKEN`** (private app, conversations read+write), optionally
   **`WEBHOOK_SHARED_SECRET`** and **`DEFAULT_FROM_USER_ID`**.
2. In your ticket workflow, add a **"Send a webhook"** action (POST) targeting your endpoint URL.
3. Use the action's **custom request body** to send flat keys:
   `threadId`, `ticketId`, `message`, `fromUserId`. (If you use the default object payload instead,
   the handler falls back to `objectId` for the ticket and reads `message`/`fromUserId` from mapped
   properties or the `DEFAULT_FROM_USER_ID` env.)
4. If you set `WEBHOOK_SHARED_SECRET`, add a matching custom header **`x-webhook-secret`** in the action.

The handler always responds `200` with a JSON `{ sent, messageId, errorCode }` body — even on a handled
failure — so HubSpot doesn't retry-storm a bad enrolment. Inspect `errorCode`, not the HTTP status.

Adapters included: `lambdaHandler` (API Gateway proxy) and `nodeHandler` (`(req, res)` for plain http /
Express). For a Cloudflare Worker (ESM), wrap the core:

```js
import { handleWebhook, verifySharedSecret } from './webhook-handler.js'; // via a CJS→ESM bundler
export default {
  async fetch(request, env) {
    if (!verifySharedSecret(Object.fromEntries(request.headers), env.WEBHOOK_SHARED_SECRET)) {
      return new Response('{"errorCode":"UNAUTHORISED"}', { status: 401 });
    }
    const out = await handleWebhook(await request.json(), {
      token: env.CONVERSATIONS_TOKEN,
      defaultFromUserId: env.DEFAULT_FROM_USER_ID,
    });
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  },
};
```

## Setup (poller — the genuinely no-Data-Hub path)

No workflow, no Data Hub. You run a script on a schedule; it finds and replies to matching tickets itself.

1. **Create a marker property** on tickets in your portal (Settings → Properties), e.g.
   `auto_reply_sent_at` (single-line text or datetime). The poller uses it to avoid replying twice —
   this is the dedupe a workflow's enrolment would normally give you.
2. **Private app** with scopes: `conversations.read`, `conversations.write`, `tickets` read **and write**
   (write is needed to stamp the marker). Available on all tiers — no Data Hub.
3. Set env (see `.env.example`): `CONVERSATIONS_TOKEN`, `FROM_USER_ID`, `REPLY_MESSAGE`,
   `MARKER_PROPERTY`, optionally `PIPELINE_STAGE_ID`, `MAX_PER_RUN`, `DRY_RUN`.
4. **Start with `DRY_RUN=1`** and run once: `node poller.js`. It logs what it *would* send without sending.
   Check the matched tickets are exactly what you intend before you flip it off.
5. Schedule it: cron, a scheduled Lambda, GitHub Actions, a Cloudflare Cron Trigger — anything that runs
   `node poller.js` every N minutes.

How it stays safe:

- **Dedupe:** the search filters on `MARKER_PROPERTY NOT_HAS_PROPERTY`, and each ticket is stamped only
  *after* a confirmed send. Worst case (a stamp fails) is a rare, logged duplicate — never a silent miss.
- **Blast radius:** `MAX_PER_RUN` (default 25) caps replies per cycle; the run reports `capped: true` when
  it hits the limit so you notice a backlog instead of firing hundreds of messages at once.
- **Tighten the search:** `PIPELINE_STAGE_ID` and the `extraFilters` config narrow enrolment. This filter
  is the only thing between you and a mass auto-reply — keep it tight.

## What you must verify in your portal (can't be hard-coded)

- **`fromUserId`** → the reply is sent AS an agent, `A-<hubspotUserId>`. Use a real user's id.
- **Thread resolution:** prefer passing **`threadId`** directly. The ticket→conversation association
  lookup is best-effort and portal-dependent — if it returns nothing, map the thread id in instead.
- **Channel eligibility:** not every channel can be sent to via API (you'll see "Channel X is not
  eligible to send message on thread Y"). Test with your actual inbox channel.

## Test

```bash
node --test
```

24 tests via Node's built-in runner + an injected fake `fetch` (Node 18+) — the core, the webhook handler,
and the poller. They cover the deterministic logic — actor id, reply-context derivation, payload shape,
webhook parsing, the shared-secret check, the poller's search/dedupe/dry-run/`maxPerRun` cap, and error
isolation. They do **not** assert live Conversations/CRM behaviour or live HubSpot delivery; those must be
verified against a real portal (see above).

---

## Takeaways

- **The Conversations API can send, not just read** — resolve the thread, derive the channel +
  recipients from the latest message, send as an agent actor.
- **Some gaps are gates.** HubSpot withholding "auto-reply without review" looks like a limitation but
  behaves like a guard rail. Build through it deliberately, not casually.

MIT © Nelis Smit · part of [tipping-scales](../../README.md) · workaround for a recurring Service Hub feature request
