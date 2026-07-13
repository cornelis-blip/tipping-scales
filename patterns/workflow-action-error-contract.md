# Workflow actions: return an error output, don't throw

**Used in:** [crm-workflow-actions](../tools/crm-workflow-actions)

## The problem

A custom coded action or external workflow action that throws (or returns a 5xx) makes the workflow
step **fail** — the enrollment stalls or errors out, and the only way to react is "the action broke."
But most CRM API failures inside a workflow aren't exceptional at all: a 404 because the record
was deleted, a 403 because a scope is missing, a search that legitimately finds nothing. Those are
outcomes a workflow author would reasonably want to branch on — retry, notify, take a different
path — not crashes.

## The fix

Always resolve with **200 and a typed output field**, and encode the failure *in the payload*
instead of the transport:

```js
const ok = (outputFields) => ({ statusCode: 200, body: { outputFields } });

async function apiError(res, extra = {}) {
  const detail = await res.text().catch(() => '');
  console.error(`HubSpot API ${res.status}: ${detail}`);
  return ok({ ...extra, errorCode: `HTTP_${res.status}` }); // 200 to HubSpot; the failure is in the field
}

async function actionGet(f, env, fetchFn) {
  const res = await hsFetch(`/crm/v3/objects/${f.objectType}/${f.recordId}`, { token: env.HUBSPOT_TOKEN, fetchFn });
  if (res.status === 404) return ok({ found: 'false', value: '' }); // not found is a normal outcome, not an error
  if (!res.ok) return apiError(res, { found: 'false', value: '' });

  const data = await res.json();
  return ok({ found: 'true', value: data.properties?.[f.property] ?? '' });
}
```

The workflow action's output fields (`found`, `errorCode`, etc.) become branch conditions in the
workflow builder — "if errorCode is set → notify Slack", "if found is false → enroll in a different
path" — instead of a stalled or hard-failed enrollment with a stack trace nobody enrolled to see.

## The corollary: guard destructive actions with a real confirmation, not a boolean

The same file gates its delete action behind a literal string match, not a boolean flag:

```js
async function actionDelete(f, env, fetchFn) {
  if (f.confirm !== 'DELETE') return ok({ deleted: 'false', status: 'not-confirmed' });
  // ...
}
```

A checkbox defaults to *something* and can be left at its default by accident. Requiring the
literal word forces whoever configures the workflow step to type it deliberately — cheap insurance
on an action that can't be undone.

## When to break this rule

Reserve a real thrown error / non-200 for failures the workflow **cannot** meaningfully branch on —
a missing required config value, an auth failure that means every subsequent call in the run will
also fail. Those should fail loudly and immediately rather than produce a confusing "success" output
that's actually broken.
