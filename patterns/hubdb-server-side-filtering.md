# Filter server-side, don't trust the page you got back

**Used in:** [hubdb-lookup](../tools/hubdb-lookup)

## The problem

A typed SDK convenience method looks like it does what you want:

```js
const rows = await client.cms.hubdb.rowsApi.getTableRows(tableId);
```

This one has no column filter — the trailing argument is request config, not a query — and returns
at most the first 1,000-row page. Filter that result in memory for a value that happens to live on
row 1,200, and you get an empty array. Not an error: an empty array, indistinguishable from "this
value genuinely doesn't exist."

That's the dangerous shape of this bug class: it looks like *no match* instead of *failure*, so it
passes every happy-path test and only shows up once real data crosses whatever cap the convenience
method silently applies. By the time it fires, it's usually in production, weeks after the code
shipped, and the failure looks like bad data rather than a code path.

## The fix

Go around the typed helper and call the REST endpoint directly with a server-side filter:

```js
const resp = await client.apiRequest({
  method: 'GET',
  path: `/cms/v3/hubdb/tables/${tableId}/rows`,
  qs: { [column]: value }, // server-side filter — HubDB does support this, just not on the typed method
});
const rows = (await resp.json()).results || [];
```

The server now returns only matching rows, so table size stops being a variable. Add a client-side
exact-match check on top (normalise case/whitespace) as a safety layer in case the filter returns a
near-match rather than an exact one — see `findHubDbRow` in
[hubdb-lookup.js](../tools/hubdb-lookup/hubdb-lookup.js).

## The general lesson

This isn't really a HubDB-specific bug — it's what to suspect any time an SDK's "just works"
method is convenient enough that nobody reads its pagination contract. Before trusting a typed
helper for anything that scales with client data:

1. Check what the underlying endpoint calls its page size default and cap.
2. Check whether the helper exposes a query/filter parameter, or only ever fetches-then-lets-you-
   filter-in-memory.
3. If it caps and can't filter server-side, use the raw REST call instead — typed convenience is not
   worth a silent data-loss bug that only appears at scale.

**"It works" and "it works at scale" are different claims** — treat anything backed by a growing
table as a scale claim until proven otherwise.
