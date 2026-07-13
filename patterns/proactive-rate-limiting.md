# Proactive rate limiting: a token bucket in front of retry

**Complements:** [retry-with-backoff](retry-with-backoff.md)

## The problem

Retry-with-backoff is a *reaction* to a 429 that already happened. That's fine for occasional calls,
but for a loop that fires dozens or hundreds of API calls in quick succession (bulk enrichment, a
sweep over every record of a type), reacting to 429s one at a time means the loop spends real time
hitting the limit, backing off, and hitting it again — slower overall than just not exceeding the
limit in the first place.

## The fix

Put a token bucket in front of the calls: a fixed rate of tokens refill per second, each call
consumes one, and a call that arrives with no tokens left waits instead of firing (and risking a
429). Retry-with-backoff stays underneath as the safety net for the 429s that get through anyway.

```js
function makeRateLimiter({ rate = 9, capacity = 9 } = {}) {
  let tokens = capacity;
  let lastRefill = Date.now();

  async function take() {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(capacity, tokens + elapsed * rate);
    lastRefill = now;

    if (tokens < 1) {
      const waitMs = ((1 - tokens) / rate) * 1000;
      await sleep(waitMs);
      tokens = 0;
    } else {
      tokens -= 1;
    }
  }

  return async function limitedCall(fn) {
    await take();
    return withRetry(fn); // 429s that still get through are handled by the retry loop
  };
}

const callHubSpot = makeRateLimiter({ rate: 9, capacity: 9 }); // stay under a ~10/sec API limit
await Promise.all(records.map((r) => callHubSpot(() => updateRecord(r))));
```

## Picking `rate` and `capacity`

Set `rate` a little under the actual documented limit for the endpoint you're calling (HubSpot's
search API and general CRUD endpoints have different caps) — leaving headroom for other processes
sharing the same token. `capacity` controls burst tolerance: equal to `rate` means no burst above the
steady-state rate; higher than `rate` allows a short burst before throttling kicks in, useful if
your workload is bursty rather than a steady stream.

## When this is worth the extra code

Skip it for a handful of sequential calls — plain `withRetry` is simpler and the token bucket is
overhead with no payoff. Reach for it once you're firing calls in a loop or `Promise.all` fast
enough that hitting 429 mid-run is the expected case, not the exception.
