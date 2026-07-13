# Retry with backoff (429-aware)

**Used in:** [hubdb-lookup](../tools/hubdb-lookup), [bulk-associations](../tools/bulk-associations), [ticket-auto-reply](../tools/ticket-auto-reply)

## The problem

HubSpot rate-limits by returning `429`. Two wrong reactions are both common:

- **Not retrying at all** — a burst of normal traffic (a bulk operation, a fan-out) fails outright
  the moment you touch a limit, even though the very next request would have succeeded.
- **Retrying too eagerly** — a fixed short delay, or no jitter, means every caller that got
  rate-limited together retries at the same instant and re-triggers the limit. This is how a retry
  loop makes an outage worse instead of absorbing it.

## The fix

Retry **only** on 429, back off exponentially, add jitter so simultaneous callers don't retry in
lockstep, and honour a `retry-after` header when HubSpot sends one (it doesn't always).

```js
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function withRetry(fn, { retries = 3, baseDelayMs = 350 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status;
      if (status !== 429 || attempt >= retries) throw err;

      const retryAfterHeader =
        err?.headers?.['retry-after'] || err?.response?.headers?.['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;

      const delay =
        retryAfterMs ??
        baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 150);

      await sleep(delay);
      attempt++;
    }
  }
}
```

Usage — wrap any single API call:

```js
const resp = await withRetry(() => client.apiRequest({ method: 'GET', path: '...' }));
```

## Why *only* 429

Retrying a 4xx that isn't a rate limit (a 403, a 404, a malformed-body 400) just delays a failure
that will never succeed — it burns the retry budget on something backoff can't fix. Check the status
code and only loop on 429; let everything else throw immediately.

## Known drift

`bulk-associations` and `ticket-auto-reply` carry a version of this function that drops the
`retry-after` header check and just does exponential backoff + jitter. That's an acceptable
simplification (HubSpot doesn't always send the header anyway) but it *is* drift — three copies of
"the same" retry loop that aren't identical. If you're touching one of them, prefer converging on
the version above.

## When not to use this

- Anything **not** idempotent (e.g. a `POST` that creates a record) needs an idempotency check
  before you retry it — otherwise a retry after a false-negative timeout can create a duplicate.
  HubSpot's batch create/update endpoints are idempotent on `id`; a bare `POST /objects/{type}`
  create is not.
