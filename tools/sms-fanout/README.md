# sms-fanout

**Broadcast one inbound Twilio SMS to many destinations — so HubSpot *and* your shared inbox both see every reply.**

---

## The problem

A Twilio phone number can POST inbound messages to exactly **one** webhook. That's fine until you
need two systems to see replies at once — say your support team lives in a shared inbox (Front,
Zendesk, Help Scout) but you also want every reply logged on the contact's HubSpot timeline.

You can only point the number at one of them. The other goes blind. There's no native "send this to
both" setting.

## The fix

Point the number at this Twilio Function instead. It:

1. **Fans the message out to every destination in parallel** (`Promise.allSettled`), so one slow or
   failing destination never holds up the others.
2. **Always returns an empty `200` to Twilio**, so a downstream error never makes Twilio retry — the
   #1 cause of duplicate messages in setups like this.
3. Replays a **faithful copy of the original Twilio payload** (including MMS media) to each webhook,
   so any tool that already accepts a Twilio SMS webhook works with zero changes — including
   HubSpot's own inbound Twilio webhook.

```
        inbound SMS
             │
     Twilio phone number
             │
      ┌──────┴───────┐  (this Function)
      ▼      ▼       ▼
  webhook  webhook  HubSpot timeline
  (Front)  (…)      (optional: Note on contact)
             │
       <Response></Response>   ← empty 200, no auto-reply, no retry
```

## Destinations

| Destination | How | Config |
|---|---|---|
| Any webhook(s) | Raw Twilio payload replayed | `FANOUT_WEBHOOK_URLS` (comma-separated) |
| HubSpot timeline | Contact looked up by phone → reply logged as a Note | `HUBSPOT_MODE=api` + `HUBSPOT_PRIVATE_APP_TOKEN` |

HubSpot in **webhook mode** doesn't need the API option — just put its inbound Twilio webhook URL in
`FANOUT_WEBHOOK_URLS` like any other destination. Use `HUBSPOT_MODE=api` when you'd rather this
Function create the timeline Note directly (contact lookup + note), no separate webhook required.

## Why it's a single file

Twilio Functions resolve sibling files through `Runtime.getFunctions()`, **not** plain
`require('./x')` — so a multi-file setup silently fails to load helpers at runtime. Everything is
inlined into [`sms-fanout.js`](sms-fanout.js) on purpose. Upload it as one **Public** function.

## Deploy

1. **Twilio Console → Functions & Assets → Services → Create Service.**
2. Add a Function at path `/inbound`, **Public**, and paste in `sms-fanout.js`.
3. **Environment Variables** tab → set the vars from [`.env.example`](.env.example).
4. **Deploy All**, then copy the function URL (`https://<service>-xxxx.twil.io/inbound`).
5. **Phone Numbers → your number → Messaging → "A message comes in"** → set to that URL, `HTTP POST`.

**Rollback:** before step 5, note the number's current webhook URL. To roll back, set it back — the
Function can stay deployed, it just stops receiving traffic. (Tip: that old URL is often exactly what
you put in `FANOUT_WEBHOOK_URLS` so the original tool keeps working alongside the new one.)

## Test

```bash
node --test
```

No install required — uses Node's built-in test runner and an injected fake `fetch`
([`sms-fanout.test.js`](sms-fanout.test.js)). Node 18+.

---

## Takeaways

- **Fan-out + `Promise.allSettled` + always-200** is the general shape for any "one webhook, many
  consumers" problem — not just SMS.
- **Idempotency starts at the transport.** The empty 200 is what stops Twilio retrying and
  double-delivering; get that wrong and every downstream dedupe effort is fighting a self-inflicted
  problem.

MIT © Nelis Smit · part of [tipping-scales](../../README.md)
