# Resilient fan-out: one failure must not sink the rest

**Used in:** [sms-fanout](../tools/sms-fanout)

## The problem

Broadcasting one inbound event (a webhook, a message) to several destinations has two failure modes
that are easy to get wrong:

1. **`Promise.all` semantics.** If one destination throws, `Promise.all` rejects immediately —
   destinations that would have succeeded never even get called, or their results are discarded.
2. **The wrong status code back to the source.** Many providers (Twilio included) treat a
   non-2xx response, or a slow one, as "delivery failed" and **retry** — which means the event fires
   again, and now every destination that *did* succeed the first time gets it twice.

## The fix

Fan out concurrently with `Promise.allSettled` (every destination gets a fair, isolated attempt
regardless of the others), and always return a clean 200 to the source so it never retries:

```js
async function replayToWebhook(url, event, fetchFn) {
  try {
    const response = await fetchFn(url, { method: 'POST', body: buildFormBody(event) });
    if (response.ok) return { url, ok: true, status: response.status };
    return { url, ok: false, status: response.status };
  } catch (err) {
    return { url, ok: false, error: err.message }; // never throws — a failed destination is data, not an exception
  }
}

const tasks = destinations.map((url) => replayToWebhook(url, event, fetchFn));
const settled = await Promise.allSettled(tasks);
const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false, error: s.reason?.message }));

console.log(`fan-out results: ${JSON.stringify(results)}`); // log; still return 200 regardless
return callback(null, /* empty 200 response */);
```

Two things are doing the work here, and both matter:

- Every per-destination function **catches its own errors and returns a result object** instead of
  letting them propagate. A function that can throw *and* is being fanned out is a function whose
  failure mode you haven't decided yet.
- The handler's return value to the upstream provider is **decoupled from whether any individual
  destination succeeded.** Success/failure per destination is logged for observability, not surfaced
  as the overall response.

## When this doesn't apply

If the upstream provider needs to know delivery failed (e.g. it should retry, or alert a human), a
blanket 200 is the wrong call — this pattern is specifically for **fan-out where the source has its
own retry-and-duplicate behaviour you need to suppress.** Check the provider's retry semantics before
assuming "always return 200" is safe; for Twilio inbound SMS it is (retries duplicate the message to
every destination), for a payment webhook it very much is not.
