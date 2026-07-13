# Batch chunking with a dry-run mode

**Used in:** [bulk-associations](../tools/bulk-associations)

## The problem

HubSpot's v4 batch endpoints (associations, objects) cap how many inputs you can send per call —
100, in practice, for associations. Feed them a list of 3,000 pairs from a CSV and the naive
`{ inputs: allOfThem }` call just fails. Separately: anything that operates in bulk and can *remove*
data (association archive, batch delete) is exactly the kind of operation you want to preview before
it runs for real — "here's what would happen" beats finding out after 3,000 associations are gone.

## The fix

Chunk the input list to the batch cap, and thread a `dryRun` flag through the same code path so
the preview and the real run are guaranteed to match (no separate "preview" logic to drift from the
real one):

```js
const BATCH_LIMIT = 100; // conservative, matches v4 batch caps

function chunk(arr, n = BATCH_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function runBatches({ op, path, buildInput, pairs }, ctx) {
  const { token, fetchFn = fetch, dryRun = false } = ctx;
  const summary = { op, total: pairs.length, batches: 0, succeeded: 0, failed: 0, errors: [], dryRun };

  for (const group of chunk(pairs)) {
    summary.batches++;
    if (dryRun) {
      summary.succeeded += group.length; // count it, but never call the API
      continue;
    }
    const inputs = group.map(buildInput);
    const res = await withRetry(() => hsFetch(path, { method: 'POST', token, fetchFn, body: { inputs } }));
    if (res.status === 204 || res.ok) {
      summary.succeeded += group.length;
    } else {
      summary.failed += group.length;
      summary.errors.push({ status: res.status, detail: await safeText(res) });
    }
  }
  return summary;
}
```

Every operation (`batchCreate`, `batchArchive`, `batchArchiveLabeled` in
[bulk-associations.js](../tools/bulk-associations/bulk-associations.js)) is a thin wrapper that
supplies `path` and `buildInput` to this one loop — the chunking, retry, and dry-run behaviour is
written and tested exactly once.

## Why the dry-run check lives *inside* the shared loop

If dry-run were a separate branch at the call site ("if dryRun, do X, else call runBatches"), the
preview and the real path are two pieces of code that can silently diverge — the preview could
report success on inputs that would actually fail validation. Keeping the flag inside the loop that
also does the real work means the only thing dry-run skips is the network call; everything else
(chunking, counting, which pairs land in which batch) is identical to a real run.

## When to reach for this

Any bulk operation against a batch endpoint that (a) has a per-call size cap, or (b) is hard to
undo. If only one of those is true, you may only need half the pattern — chunking without dry-run
for bulk creates, dry-run without chunking for a small destructive one-shot.
