# Idempotency by recomputing from source of truth (plus a sweeper for what still gets stuck)

## The problem

Workflow steps re-run: HubSpot retries on transient failures, a human re-enrolls a record, a
workflow gets edited and existing enrollments replay a step. Anything that isn't safe to run twice
— sending a duplicate notification, double-incrementing a counter, re-creating a record that already
exists — needs an idempotency story. The usual reach is an "already processed" flag: set a property
when the action runs, check it before running again. That works, but it adds a new failure mode of
its own — if the action dies *after* the API call but *before* it manages to set the flag, the next
run treats it as never-having-happened and does it again anyway. The flag is only as reliable as the
step that sets it.

## The fix (part 1): make the action re-entry-safe by construction

Where the action's job is to *reflect current state* rather than *append an event*, write it so that
running it again produces the same result instead of a duplicate — by recomputing from the record's
actual current data instead of trusting a flag:

- A step that stamps "who currently owns this deal" onto a property should **look up the current
  owner and set it** every time, not check a flag and skip if already stamped. Running it twice
  writes the same value twice — harmlessly.
- A step that resolves "the active review for this record" should **search for what's active right
  now** (by status, not by an ID cached from an earlier run) so a re-run finds the same answer even
  if the earlier run's cached ID is stale or wrong.

This class of action needs zero idempotency bookkeeping, because "run it again" and "run it the
first time" are the same operation. It only works when the action is naturally read-and-set rather
than append-only — a step that sends an email or creates a note can't be made idempotent this way,
because "run it again" really does mean "send it again."

## The fix (part 2): a sweeper for the runs that get stuck anyway

Recompute-from-source-of-truth handles re-runs that complete. It doesn't handle a run that starts,
sets an in-progress marker, and then never finishes (the process died, an external call hung). That
record is now stuck: not done, but also not eligible to be picked up as "not yet started." Rather
than add more inline logic to every action to handle this, run a small separate, scheduled job whose
only purpose is to find markers that have been "in progress" for implausibly long and reset them:

```js
// A separate scheduled sweep, not inline in the action itself.
const stuck = await findRecords({
  filter: { property: 'step_in_progress', operator: 'EQ', value: 'true' },
  idleLongerThanMinutes: 30,
});
for (const record of stuck) {
  await clearInProgressFlag(record.id); // let the normal enrollment logic pick it back up
}
```

Keeping this as a separate sweeper (rather than folding "am I stuck?" logic into the action itself)
keeps the action simple and gives you one place to look when something is stuck, instead of stuck-
detection logic scattered across every action that sets an in-progress flag.

## When to use which

- State the action is *supposed* to reflect (current owner, current active record, current status)
  → recompute from source of truth, no flag needed.
- An action that has an unavoidable "in progress" window (an external call, a multi-step sequence)
  → an in-progress marker plus a separate sweeper, not a same-action retry-with-flag.
