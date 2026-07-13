# patterns

**Reusable snippets and write-ups — the techniques behind the tools, stripped of any one tool's
specifics.**

Every tool in [`../tools`](../tools) re-solves a handful of the same problems: HubSpot rate-limits
you, its typed SDKs quietly cap what they return, its batch APIs want work chunked, and a custom
coded action has to behave whether it's dealing with a client's data or your own retry loop. Rather
than let each tool carry a slightly-different copy of the same fix, this folder is where the fix
itself lives — once, documented, and named.

If you're about to write a new tool and it needs retry logic, batch chunking, or a resilient
fan-out, check here first. If you fix one of these in a way that's better than what's written down,
update the pattern — the tools folders can then link to it instead of re-explaining it.

## Index

| Pattern | Problem it solves |
|---|---|
| [retry-with-backoff](retry-with-backoff.md) | HubSpot 429s need a retry, but retrying blindly (or too eagerly) makes rate-limiting worse. |
| [proactive-rate-limiting](proactive-rate-limiting.md) | For a loop firing many calls, reacting to 429s one at a time is slower than just not hitting the limit. |
| [cursor-pagination](cursor-pagination.md) | HubSpot list endpoints page with an `after` cursor, not an offset — read only the first page and you silently miss the rest. |
| [hubdb-server-side-filtering](hubdb-server-side-filtering.md) | Typed SDK convenience methods silently cap results — filter server-side instead of trusting the page you got back. |
| [batch-chunking-and-dry-run](batch-chunking-and-dry-run.md) | Bulk CRM operations need chunking to respect batch limits, and a dry-run mode before anything destructive runs for real. |
| [resilient-fanout](resilient-fanout.md) | Sending one event to multiple destinations — one slow/failing destination must never block or duplicate-trigger the others. |
| [workflow-action-error-contract](workflow-action-error-contract.md) | A workflow action that throws stops the workflow. Returning a typed error output lets the workflow branch instead. |
| [host-agnostic-core](host-agnostic-core.md) | Writing logic once that runs in a CCA, a private app, and a serverless function — and is actually unit-testable. |
| [shared-block-build-and-check](shared-block-build-and-check.md) | CCAs can't `require` a shared file — a build step that injects a single source of truth, and a check step that catches drift. |
| [idempotent-recompute-and-sweep](idempotent-recompute-and-sweep.md) | Workflow steps re-run. Recompute state from source of truth where you can; sweep for what still gets stuck where you can't. |

## Genericised, not generic

These write-ups come from real code in `../tools` — the snippets are lightly adapted (names
changed, comments trimmed) but the technique is exactly what's running. When a pattern is a
one-line variant of another tool's version, that's noted rather than hidden; consistency across the
repo is worth more than each tool having its own slightly-different retry loop.
