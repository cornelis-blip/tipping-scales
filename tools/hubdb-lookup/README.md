# hubdb-lookup

**Filtered HubDB row lookups that don't silently drop rows.**

If you've ever had a HubDB-backed lookup that worked perfectly in testing and then quietly failed
for *some* records in production — with no error anywhere — this is almost certainly why.

---

## The gotcha

The typed HubDB client method most examples reach for:

```js
const rows = await client.cms.hubdb.rowsApi.getTableRows(tableId);
```

has two properties that combine into a silent data-loss bug:

1. **It has no server-side column filter.** Its trailing argument is request config, not a query.
   You get the whole table back and filter in memory.
2. **It returns at most the first 1,000-row page.**

So the moment your table grows past 1,000 rows, any lookup for a value that lives on a later page
matches **nothing**. No match, no exception, no log line. The row just isn't in the data you got
back.

It fails the worst way a bug can: it looks like "no match" instead of "error", so it slips through
every happy-path test and only shows up once the table is big enough — often long after you shipped.

I hit this on a lead-routing system: companies were auto-assigned a territory from a ZIP → territory
HubDB table. It worked for months. Then the table crossed ~2,400 rows and companies whose ZIP
happened to sit beyond row 1,000 started landing with no territory at all. Everything "worked" — the
data was just quietly wrong.

## The fix

Query the **REST rows endpoint** directly with a server-side column filter. HubDB *does* support
filtering on the URL (`?<column>=<value>`) — it's just not exposed on the typed helper. The server
returns only the matching row(s), so table size is irrelevant.

```js
const resp = await client.apiRequest({
  method: 'GET',
  path: `/cms/v3/hubdb/tables/${tableId}/rows`,
  qs: { [column]: value },   // server-side filter — no 1,000-row cap
});
const rows = (await resp.json()).results || [];
```

Add a 429-aware retry (HubDB endpoints rate-limit) and a client-side exact-match safety check, and
the lookup is correct at any table size.

---

## Files

| File | Use it when |
|---|---|
| [`custom-coded-action.js`](custom-coded-action.js) | You want a **HubSpot custom coded action**. Single-file, copy-paste ready, helpers inlined (CCAs can't `require` local files). |
| [`hubdb-lookup.js`](hubdb-lookup.js) | You're in a **private app, serverless function, or script** and can import a module. Exports `lookupHubDbRows`, `findHubDbRow`, `withRetry`. |

## Custom coded action — setup

1. Paste `custom-coded-action.js` into your action.
2. Set `TABLE`, `COLUMN`, `OUT_COLUMN` at the top to your table.
3. Add input field **`lookupValue`** (the value to look up).
4. Add output fields **`found`** (boolean) and **`mappedValue`** (text).
5. Add secret **`HUBDB_TOKEN`** — a private app token with HubDB read access.

The included example normalises the input (strips a ZIP+4 suffix, lowercases). Delete or adjust that
line for your own key format.

## Module — usage

```js
const hubspot = require('@hubspot/api-client');
const { findHubDbRow } = require('./hubdb-lookup');

const client = new hubspot.Client({ accessToken: process.env.HUBDB_TOKEN });

const row = await findHubDbRow({
  client,
  tableIdOrName: 'zip_to_territory',
  column: 'zip_code',
  value: '32256',
});

console.log(row?.values?.territory ?? 'no match');
```

---

## Takeaways

- **"It works" and "it works at scale" are different claims.** This bug is invisible until the table
  crosses a threshold.
- **A convenient SDK method can hide a hard limit.** When data silently goes missing, suspect
  pagination and page caps first.

MIT © Nelis Smit · part of [tipping-scales](../../README.md)
