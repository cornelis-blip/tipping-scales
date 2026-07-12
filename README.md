# tipping-scales

**Open-source tools, patterns, and custom code for HubSpot — CRM data operations, integrations, and the workflow logic HubSpot can't do natively.**

Maintained by [Nelis Smit](https://www.linkedin.com/) — HubSpot developer, [Growth-Pad](https://growth-pad.com) (HubSpot Gold Partner).

---

## Why "tipping-scales"

Jevons paradox: when a resource gets cheaper to use, we don't use less of it — we use *more*. AI has made
code cheap to produce, so the world is about to get a lot more code, not less. When production is nearly
free, the value tips toward the things that stay scarce: judgment, systems thinking, and knowing which
problems are worth solving.

This repo is where that plays out for HubSpot — small, sharp tools for the problems the platform leaves
on the table.

---

## What's here

Practical, reusable solutions to real HubSpot problems — the kind that show up as unanswered
"is this even possible?" threads in the community forum. Each tool is:

- **Self-contained** — drop it into a custom coded action or run it standalone.
- **Documented** — what it does, the inputs/outputs, and the gotcha it solves.
- **Genericised** — no client data; the technique, not the identifiers.

### Focus areas

1. **CRM data operations** — bulk updates, lookups, deduplication, association logic.
2. **Integrations** — connecting HubSpot to external services (SMS, telephony, APIs) two ways.
3. **Custom code done properly** — patterns for reliability: retries/backoff, idempotency, HubDB at scale.

---

## Structure

```
tipping-scales/
├── tools/          ← individual tools, one folder each (code + README)
├── patterns/       ← reusable snippets & write-ups (retry, idempotency, HubDB paging…)
└── README.md
```

Each tool folder carries its own README with the problem, the approach, and — where relevant — the
forum thread it answers.

---

## License

[MIT](LICENSE) — use it, fork it, ship it.
