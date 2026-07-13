# Host-agnostic core: inject `fetch`, write it once, run it anywhere

**Used in:** [crm-workflow-actions](../tools/crm-workflow-actions), [bulk-associations](../tools/bulk-associations), [ticket-auto-reply](../tools/ticket-auto-reply), [sms-fanout](../tools/sms-fanout)

## The problem

The same piece of HubSpot logic tends to need to run in several different shapes over its life: a
quick Node script today, a custom coded action tomorrow, a small hosted backend (Cloudflare
Workers / Vercel / a plain Node server) after that. If the logic is written directly against a
specific runtime's globals — importing `node-fetch`, reading `process.env` inline, assuming
`require` works — porting it means rewriting it, and testing it means hitting a real network.

## The fix

Write the actual logic as **pure functions that take their dependencies as arguments** — most
importantly `fetch` itself — rather than reaching for a global or a specific import:

```js
async function hsFetch(path, { method = 'GET', token, body, fetchFn }) {
  return fetchFn(`${HUBSPOT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function actionGet(f, env, fetchFn) {
  const res = await hsFetch(`/crm/v3/objects/${f.objectType}/${f.recordId}`, { token: env.HUBSPOT_TOKEN, fetchFn });
  // ...
}
```

Every runtime's global `fetch` satisfies the same signature, so the adapter per host is a handful
of lines — read the request, call the core function with the real `fetch`, shape the response:

```js
// server.js — a ~15-line Node adapter; Cloudflare Workers / Vercel look almost identical
const http = require('http');
const { handleAction } = require('./crm-actions');

http.createServer(async (req, res) => {
  const body = await readJsonBody(req);
  const result = await handleAction(opFromPath(req.url), body, process.env, fetch);
  res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
}).listen(process.env.PORT || 3000);
```

## What this buys you beyond portability

The same injection point that lets the core run on a new host is what makes it testable without a
network: tests pass a fake `fetchFn` and assert on what the core did with it, no HTTP mocking
library required.

```js
const fakeFetch = async (url, opts) => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
const result = await actionSearch({ objectType: 'contacts', property: 'email', operator: 'HAS_PROPERTY' }, env, fakeFetch);
```

See [crm-actions.test.js](../tools/crm-workflow-actions/backend/crm-actions.test.js),
[bulk-associations.test.js](../tools/bulk-associations/bulk-associations.test.js), and
[sms-fanout.test.js](../tools/sms-fanout/sms-fanout.test.js) — all use `node:test` with an injected
fetch, no install required.

## The one exception: custom coded actions

CCAs can't `require` a local file — they must ship as a single, self-contained file. That's why
every tool with a CCA variant (`custom-coded-action.js` alongside the module) inlines the same
core logic rather than importing it. The core is still written the same way; it's just copy-pasted
into the single-file shape rather than required. In this repo the two copies are kept in sync by
hand, which is fine at the scale of one or two files; past that,
[shared-block-build-and-check](shared-block-build-and-check.md) is the fix — a build step injects
one source of truth into every file, and a check step catches when a copy has drifted.
