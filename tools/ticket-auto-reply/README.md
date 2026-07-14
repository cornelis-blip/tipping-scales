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
| [`custom-coded-action.js`](custom-coded-action.js) | You want a **ticket-workflow custom coded action**. Single-file, copy-paste. **Needs Operations Hub Pro/Enterprise.** |
| [`webhook-handler.js`](webhook-handler.js) | You **don't** have Operations Hub. Deploy this behind a "Send a webhook" action (any Professional hub). Exports `handleWebhook`, `parseWebhookPayload`, `verifySharedSecret`, `lambdaHandler`, `nodeHandler`. |
| [`ticket-auto-reply.js`](ticket-auto-reply.js) | Private app / serverless / script. Exports `autoReply`, `sendReply`, `deriveReplyContext`, `getLatestMessage`, `buildAgentActorId`, `resolveThreadIdForTicket`. |

## Subscription requirements — read this before you pick a file

There are **two** gates, and they're separate:

- **The ticket workflow itself** needs **Service Hub Professional or Enterprise** (ticket-based workflows). You probably already have this.
- **The custom coded action** (`custom-coded-action.js`) needs **Operations Hub Professional or Enterprise** — recently marketed under the "Data Hub" banner. A Service Hub subscription **alone will not** expose the custom-code step.

If you're on **Service Hub Pro+ but not Operations Hub**, use the **webhook path** instead: a "Send a webhook" action is available in any Professional hub, and `webhook-handler.js` runs the identical logic on your own serverless endpoint. Same outcome, no Operations Hub licence.

## Setup (custom coded action)

1. Paste `custom-coded-action.js` into a ticket-based workflow action.
2. Input fields: **`threadId`** (recommended), **`ticketId`** (fallback), **`message`**,
   **`fromUserId`**.
3. Output fields: **`sent`** (enumeration), **`messageId`**, **`errorCode`**.
4. Secret **`CONVERSATIONS_TOKEN`** — private app token with conversations read + write.

## Setup (webhook — no Operations Hub)

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

15 tests via Node's built-in runner + an injected fake `fetch` (Node 18+) — the core plus the webhook
handler. They cover the deterministic logic — actor id, reply-context derivation, payload shape, webhook
parsing, the shared-secret check, error handling. They do **not** assert live Conversations API behaviour
or live HubSpot webhook delivery; those must be verified against a real portal (see above).

---

## Takeaways

- **The Conversations API can send, not just read** — resolve the thread, derive the channel +
  recipients from the latest message, send as an agent actor.
- **Some gaps are gates.** HubSpot withholding "auto-reply without review" looks like a limitation but
  behaves like a guard rail. Build through it deliberately, not casually.

MIT © Nelis Smit · part of [tipping-scales](../../README.md) · workaround for a recurring Service Hub feature request
