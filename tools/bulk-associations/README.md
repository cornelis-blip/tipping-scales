# bulk-associations

**Add or remove HubSpot associations in bulk, from a list — including the bulk *removal* that no native tool can do.**

---

## The gap

HubSpot gives you three ways to manage associations, and all three leave the same hole:

| Method | Add | Remove | From a list, at scale |
|---|:--:|:--:|:--:|
| Imports | ✅ | ❌ | ✅ (add only) |
| Native workflow actions (2024) | ✅ | ❌ | ❌ (one record at a time) |
| **This tool (v4 batch API)** | ✅ | ✅ | ✅ |

So the moment you need to **un-associate** records in bulk — cleaning up a bad sync, undoing a
mis-mapped import, detaching thousands of contacts from a company — you're on the API. This wraps the
v4 batch endpoints so you can do it from a simple `fromId,toId` list.

## Safety first

Archiving associations is **not reversible**. So the runner is **dry-run by default** — it shows you
exactly what it would do and touches nothing until you add `--commit`.

## Usage

Input is one pair per line, `fromId,toId` (a header row is ignored):

```
12345,67890
12346,67890
12347,67890
```

```bash
# Preview creating default contact→company associations:
HUBSPOT_TOKEN=pat-xxx node run.js --create --from contacts --to companies --label default --file pairs.csv

# Actually remove ALL associations between the listed pairs:
HUBSPOT_TOKEN=pat-xxx node run.js --archive --from contacts --to companies --file pairs.csv --commit

# Remove only a specific labeled association, keeping the others:
HUBSPOT_TOKEN=pat-xxx node run.js --archive-label --from deals --to contacts --label "Decision maker" --file pairs.csv --commit
```

You can also pass an explicit type instead of a label: `--category USER_DEFINED --type-id 42`.

### Options

| Flag | Meaning |
|---|---|
| `--create` / `--archive` / `--archive-label` | Which operation to run |
| `--from` / `--to` | Object types (e.g. `contacts`, `companies`, `deals`, `2-XXXXXXX`) |
| `--file` | Path to the `fromId,toId` list (or pipe it via stdin) |
| `--label` | Association label name, or `default` for the primary/unlabeled one |
| `--category` + `--type-id` | Explicit association type (skips label lookup) |
| `--commit` | Actually apply. Omit for a dry run. |

## The endpoint quirk worth knowing

The v4 batch endpoints don't take the same shape — this trips people up constantly:

```jsonc
// batch/create        → `to` is an OBJECT
{ "from": { "id": "1" }, "to": { "id": "2" }, "types": [ { ... } ] }

// batch/archive        → `to` is an ARRAY
{ "from": { "id": "1" }, "to": [ { "id": "2" } ] }

// batch/labels/archive → `to` is an OBJECT, with the label in `types`
{ "from": { "id": "1" }, "to": { "id": "2" }, "types": [ { ... } ] }
```

`archive` removes *all* associations between the pair; `labels/archive` removes only the one label and
leaves the rest. The library handles both — but if you ever hand-roll these calls, that's the bug.

## Use it as a library

```js
const { batchArchive, resolveType, batchCreate } = require('./bulk-associations');

const ctx = { token: process.env.HUBSPOT_TOKEN, dryRun: true };
const type = await resolveType({ fromType: 'contacts', toType: 'companies', label: 'default' }, ctx);
const summary = await batchCreate({ fromType: 'contacts', toType: 'companies', pairs, type }, ctx);
```

The core takes an injected `fetch`, so it drops into a serverless function or a custom coded action
unchanged.

## Test

```bash
node --test
```

No install — Node's built-in runner + an injected fake `fetch` (9 tests). Node 18+.

---

## Takeaways

- **"You can add it but not remove it" is a recurring HubSpot shape** — imports, associations, list
  memberships. The remove path is almost always API-only.
- **Batched, chunked, dry-run-first** is the responsible pattern for any destructive bulk operation.

MIT © Nelis Smit · part of [tipping-scales](../../README.md) · answers a recurring community ask about bulk-removing associations
