# Cursor pagination: follow `paging.next.after` until it's gone

**Applies to:** any HubSpot v3/v4 list or association endpoint (contacts, associations, engagements…)

## The problem

HubSpot's list-style endpoints page with a cursor, not an offset — the response tells you the token
for the next page, and there's no reliable way to jump to "page 12" or know the total count up
front. Code that reads only `results` and ignores `paging` silently processes just the first page
(often 100 records) and stops, with nothing indicating more existed.

## The fix

Loop while a `paging.next.after` cursor is present, and stop when it's `undefined`:

```js
async function fetchAll({ path, params = {} }, ctx) {
  const collected = [];
  let after;

  do {
    const res = await withRetry(() =>
      ctx.get(path, { ...params, limit: 500, after })
    );
    const data = await res.json();
    collected.push(...(data.results || []));
    after = data.paging?.next?.after || undefined;
  } while (after);

  return collected;
}
```

The loop condition is the whole pattern: `after` starts `undefined` (first page, no cursor), gets
set from `paging.next.after` on every response, and the `do...while` exits the moment a response
stops including one — which HubSpot guarantees means there's no more data.

## Gotchas

- **`limit: 500`** is close to the practical ceiling for most v3 list endpoints — check the specific
  endpoint's docs rather than assuming 500 everywhere; some cap lower.
- **Combine with retry.** A page-fetch loop that runs long enough to hit a 429 partway through
  should retry the failed page, not restart the whole cursor from the top — wrap each page fetch in
  [retry-with-backoff](retry-with-backoff.md), not the outer loop.
- **Memory.** `collected.push(...)` across every page is fine for thousands of records; for anything
  that could run into the hundreds of thousands, process each page as it arrives instead of
  accumulating the whole result set before returning.
- This is the endpoint-level counterpart to
  [hubdb-server-side-filtering](hubdb-server-side-filtering.md) — different API family, same root
  cause (a page cap that's invisible until data crosses it), different fix (here you *want* every
  page, so you loop instead of filtering server-side).
