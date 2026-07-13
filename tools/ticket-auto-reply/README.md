# ticket-auto-reply

**Send an automated reply into a ticket's conversation thread from a workflow — the Service Hub automation HubSpot doesn't give you natively.**

> ⏳ **Valid as of July 2026 — expect to rework this around 2026-09-23.** HubSpot has a breaking
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

## ⚠️ Dangers — think before you automate this

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
| [`custom-coded-action.js`](custom-coded-action.js) | You want a **ticket-workflow custom coded action**. Single-file, copy-paste. |
| [`ticket-auto-reply.js`](ticket-auto-reply.js) | Private app / serverless / script. Exports `autoReply`, `sendReply`, `deriveReplyContext`, `getLatestMessage`, `buildAgentActorId`, `resolveThreadIdForTicket`. |

## Setup (custom coded action)

1. Paste `custom-coded-action.js` into a ticket-based workflow action.
2. Input fields: **`threadId`** (recommended), **`ticketId`** (fallback), **`message`**,
   **`fromUserId`**.
3. Output fields: **`sent`** (enumeration), **`messageId`**, **`errorCode`**.
4. Secret **`CONVERSATIONS_TOKEN`** — private app token with conversations read + write.

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

7 tests via Node's built-in runner + an injected fake `fetch` (Node 18+). They cover the deterministic
logic — actor id, reply-context derivation, payload shape, error handling. They do **not** assert live
Conversations API behaviour; that must be verified against a real portal (see above).

---

## Takeaways

- **The Conversations API can send, not just read** — resolve the thread, derive the channel +
  recipients from the latest message, send as an agent actor.
- **Some gaps are gates.** HubSpot withholding "auto-reply without review" looks like a limitation but
  behaves like a guard rail. Build through it deliberately, not casually.

MIT © Nelis Smit · part of [tipping-scales](../../README.md) · workaround for a recurring Service Hub feature request
