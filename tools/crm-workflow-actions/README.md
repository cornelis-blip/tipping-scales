# crm-workflow-actions

**A HubSpot app that adds small, reusable CRM workflow actions — with dropdowns — for the API operations workflows don't expose natively: search, get, delete, and batch-update.**

Upload it with `hs project upload`. No per-portal code editing: pick the object type and property from dropdowns and go.

---

## What you get

Four workflow actions, each single-purpose and driven by dropdowns:

| Action | Does | Key inputs (dropdowns in **bold**) |
|---|---|---|
| **CRM: Search for a record** | Finds the first record matching a filter | **object type**, **property**, **operator**, value |
| **CRM: Get a property value** | Reads one property off any record by ID | **object type**, record ID, **property** |
| **CRM: Delete a record** | Deletes a record (guard-railed) | **object type**, record ID, type `DELETE` to confirm |
| **CRM: Batch-update a property** | Sets one property on many records at once | **object type**, record IDs, **property**, value |

The **property** dropdown loads live from the portal for whichever object type you pick — so it's
correct on every install without editing anything.

## How it's built (and why there are two parts)

In HubSpot's projects framework, a workflow action's *UI* lives in an uploadable app, but its
*execution* is routed to an external **`actionUrl`** you host. So this tool has two parts:

```
crm-workflow-actions/
├── app/                     ← upload this with `hs project upload`
│   ├── hsproject.json
│   └── src/app/
│       ├── app-hsmeta.json
│       └── workflow-actions/
│           ├── crm-search-hsmeta.json
│           ├── crm-get-hsmeta.json
│           ├── crm-delete-hsmeta.json
│           └── crm-batch-update-hsmeta.json
└── backend/                 ← deploy this; the actions call it
    ├── crm-actions.js       ← host-agnostic core (search/get/delete/batch-update + options)
    ├── server.js            ← minimal Node adapter
    ├── crm-actions.test.js  ← 10 tests, node:test, no install
    └── .env.example
```

**Auth model:** the execution payload from HubSpot does not include an access token, so the backend
authenticates with its own **private app token** (`HUBSPOT_TOKEN`). That's the right fit for a
private/internal app. A public OAuth app would instead look up a stored per-portal token in the
backend — the CRM logic in `crm-actions.js` stays identical.

## Setup

### 1. Deploy the backend

```bash
cd backend
cp .env.example .env      # fill in HUBSPOT_TOKEN + a generated ACTION_SECRET
node server.js            # or deploy to Cloudflare Workers / Vercel / Twilio Functions
node --test               # 10 passing tests
```

The core (`crm-actions.js`) takes an injected `fetch`, so porting to another runtime is a ~15-line
adapter — see the note at the top of `server.js`.

### 2. Point the app at your backend

In each file under `app/src/app/workflow-actions/`, replace the two placeholders:

- `YOUR-BACKEND-HOST` → your deployed host
- `CHANGE-ME-ACTION-SECRET` → the `ACTION_SECRET` you set in `.env`

(The `actionUrl` carries the operation in its path — `/action/search`, `/action/get`, etc. — and the
`optionsUrl` for every property dropdown points at `/options`.)

Also set `CHANGE-ME-PORTAL-ID` in `app-hsmeta.json` and confirm the scopes match the objects you use.

### 3. Upload

```bash
cd app
hs project upload
```

Then install the app in your portal, and the four actions appear in the workflow action picker.

## Notes & limits

- **Batch-update** uses the CRM batch endpoint — up to 100 IDs per call.
- **Delete** is intentionally guard-railed: nothing happens unless the confirm field is exactly
  `DELETE`. Deletes are hard to undo; make the workflow say so out loud.
- The property dropdown returns up to 100 options per query and is searchable; refine by typing.
- Errors from the CRM API are surfaced as an `errorCode` output (e.g. `HTTP_403`) rather than failing
  the action, so you can branch on them in the workflow.

---

## Takeaways

- **Workflow-action UI and execution are separate concerns** in the projects framework — the app is
  just a typed form; your backend is where the work happens.
- **Dynamic `optionsUrl` dropdowns** are the difference between a tool that's reusable across portals
  and one you have to edit for each. Read `objectType` from the options payload and list live.

MIT © Nelis Smit · part of [tipping-scales](../../README.md)
