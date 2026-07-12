/**
 * hubdb-lookup — filtered HubDB row lookups that don't silently drop rows.
 *
 * The problem this solves:
 *   The typed HubDB client `rowsApi.getTableRows()` has NO column-filter
 *   parameter and returns at most the first 1,000-row page. Once a table grows
 *   past 1,000 rows, any lookup for a row beyond that page returns nothing —
 *   no match, no error. Data silently goes missing.
 *
 * The fix:
 *   Query the REST rows endpoint directly with a server-side column filter
 *   (`?<column>=<value>`), so only the matching row(s) come back regardless of
 *   table size. Wrapped in a 429-aware retry with exponential backoff.
 *
 * This module is for Node contexts (HubSpot private apps, scripts, serverless).
 * For a custom coded action — which must be a single file with no local
 * requires — copy `custom-coded-action.js` instead; it inlines this logic.
 *
 * Requires: @hubspot/api-client
 *
 * MIT © Nelis Smit — github.com/…/tipping-scales
 */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Retry a HubSpot API call, backing off only on 429 (rate limit).
 * Honours a `retry-after` header when present, otherwise uses exponential
 * backoff with jitter.
 *
 * @param {() => Promise<any>} fn        The API call to run.
 * @param {object} [opts]
 * @param {number} [opts.retries=3]      Max retry attempts after the first try.
 * @param {number} [opts.baseDelayMs=350]Base delay for exponential backoff.
 * @returns {Promise<any>}
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 350 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status;
      if (status !== 429 || attempt >= retries) throw err;

      const retryAfterHeader =
        err?.headers?.['retry-after'] || err?.response?.headers?.['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;

      const delay =
        retryAfterMs ??
        baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 150);

      await sleep(delay);
      attempt++;
    }
  }
}

/**
 * Return every row in a HubDB table whose `column` equals `value`, filtered
 * SERVER-SIDE so the 1,000-row page cap never applies.
 *
 * @param {object}  params
 * @param {import('@hubspot/api-client').Client} params.client  Authenticated client.
 * @param {string|number} params.tableIdOrName  HubDB table id or name.
 * @param {string}  params.column               Column name to filter on.
 * @param {string|number} params.value          Value to match.
 * @param {number}  [params.retries=3]
 * @returns {Promise<Array<object>>}            Matching rows (may be empty).
 */
async function lookupHubDbRows({ client, tableIdOrName, column, value, retries = 3 }) {
  const resp = await withRetry(
    () =>
      client.apiRequest({
        method: 'GET',
        path: `/cms/v3/hubdb/tables/${tableIdOrName}/rows`,
        qs: { [column]: value },
      }),
    { retries }
  );

  const body = await resp.json();
  return body.results || [];
}

/**
 * Return the single row matching `value` on `column`, with a client-side exact
 * (normalised) match as a safety layer in case the server filter returns a
 * near-match. Returns null when nothing matches.
 *
 * @param {object}  params  Same as lookupHubDbRows, plus:
 * @param {(v: any) => string} [params.normalize]  Normaliser applied to both the
 *   query value and each candidate before comparison. Defaults to trim + lowercase.
 * @returns {Promise<object|null>}
 */
async function findHubDbRow({
  client,
  tableIdOrName,
  column,
  value,
  retries = 3,
  normalize = (v) => String(v ?? '').trim().toLowerCase(),
}) {
  const target = normalize(value);
  if (!target) return null;

  const rows = await lookupHubDbRows({
    client,
    tableIdOrName,
    column,
    value: target,
    retries,
  });

  return (
    rows.find((r) => r?.values && normalize(r.values[column]) === target) || null
  );
}

module.exports = { withRetry, lookupHubDbRows, findHubDbRow };
