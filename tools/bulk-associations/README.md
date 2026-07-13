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

## ⚠️ Dangers — read before you `--commit`

Archiving associations is **destructive and not reversible.** You can re-create an association later,
but only if you know exactly what it was (correct labels included) — there's no undo and no version
history. Treat a bulk removal like a `DELETE` against production, because that's what it is.

What a wrong run can silently break:

- **Reporting & revenue attribution** — deals no longer tied to their contacts/companies drop out of
  reports and source attribution.
- **Active lists & segmentation** built on associated-record criteria.
- **Workflows** that branch on associated-record properties — and, worse, workflows that *trigger on
  association changes* can fire in bulk as you remove links.
- **Territory / permission / ownership logic** that depends on who's associated with what.
- **Integrations** that assume the links exist.

Because it's batched, a bad input list does all of that **fast**.

Mitigations (do these — they're cheap):

1. **Snapshot first.** Export or read out the current associations before you archive, so you can
   rebuild if you're wrong.
2. **Dry-run, then read the summary.** It's the default; don't skip past it.
3. **Test on 5–10 pairs** in the real portal before the full run.
4. **Use `--archive-label` when you mean one label** — plain `--archive` removes *every* link between
   the pair.
5. **Run in a low-traffic window**, and check for association-triggered workflows first.

### Why isn't bulk removal just native?

My read (informed speculation): it's a deliberate safety decision, not an oversight. Adding a wrong
association is cheap to undo; bulk-removing the wrong ones isn't, for all the reasons above. HubSpot
ships the safe half (add via import / the 2024 workflow actions) and leaves the sharp half to the API,
where a developer has to opt in on purpose. Associations are also typed and labeled now, so "remove
the association" is genuinely ambiguous — hard to expose safely as a one-click button. This tool is
that opt-in; the dry-run default is it keeping the same respect for the edge.

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
