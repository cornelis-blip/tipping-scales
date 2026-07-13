# Sharing code across custom coded actions without `require`

**Complements:** [host-agnostic-core](host-agnostic-core.md)

## The problem

Custom coded actions must ship as a single self-contained file — no local `require`. The moment you
have more than one or two CCAs that need the same helper (retry logic, error-message shaping, an
input normaliser), you're stuck copy-pasting it into every file by hand. That works right up until
you fix a bug in one copy and forget the other three — now you have four "identical" retry loops
that quietly aren't (see the *Known drift* note in
[retry-with-backoff](retry-with-backoff.md) for exactly this happening across two tools in this
repo).

## The fix

Keep the shared logic in exactly one real source file, and use a small build step to paste it into
each action file — plus a check step that fails if any action file's copy has drifted from the
source. Neither script is HubSpot-specific; both are plain Node.

```
_shared/
  shared-block.js       ← the one source of truth (withRetry, error shaping, normalisers…)
scripts/
  build-shared.js       ← injects _shared/shared-block.js into every action file, between markers
  check-shared.js       ← fails CI/pre-commit if an action file's block != the source
actions/
  do-thing-a.js         ← has `// ---- SHARED BLOCK START ----` … `// ---- SHARED BLOCK END ----`
  do-thing-b.js         ← same markers, same injected content
```

The build script is a straight string-replace between two marker comments:

```js
const fs = require('fs');
const shared = fs.readFileSync('_shared/shared-block.js', 'utf8');
const START = '// ---- SHARED BLOCK START ----';
const END = '// ---- SHARED BLOCK END ----';

for (const file of actionFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  fs.writeFileSync(file, src.replace(pattern, `${START}\n${shared}\n${END}`));
}
```

The check script does the same replace in memory and diffs it against what's actually in the file —
so a manual edit to one action's copy (instead of editing the source and rebuilding) gets caught
before it ships, rather than silently drifting.

## Why this beats a runtime shared module

There's no way around the "no `require`" constraint at runtime — the file HubSpot executes really
does have to be self-contained. Build-time injection is the closest equivalent to a shared module
that constraint allows: one source of truth to edit, many generated files that are each still valid
as a standalone CCA. The cost is a build step you have to remember to run (or wire into a commit
hook) — worth it once you have more than a couple of files sharing logic; not worth the setup for
one or two.
