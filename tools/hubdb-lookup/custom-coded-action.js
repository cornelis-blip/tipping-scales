/**
 * Example HubSpot custom coded action — safe HubDB lookup.
 *
 * What it does:
 *   Looks up an input value (here: a company's ZIP code) in a HubDB mapping
 *   table and writes the mapped value (here: a territory) back onto the record.
 *
 * Why it exists:
 *   The typed `rowsApi.getTableRows()` returns only the first 1,000 rows and
 *   can't filter by column — so once the table passes 1,000 rows, lookups for
 *   anything beyond that page silently return nothing. This uses the REST rows
 *   endpoint with a server-side filter instead, so it works at any table size.
 *
 * Custom coded actions must be a single file with no local `require`, so the
 * retry + lookup helpers are inlined below. (In a private app or script, import
 * them from hubdb-lookup.js instead.)
 *
 * ── Configure ─────────────────────────────────────────────────────────────
 *   TABLE      HubDB table id or name
 *   COLUMN     column to match on
 *   OUT_COLUMN column whose value you want back
 *   Input field:  lookupValue   (e.g. the company's postal code)
 *   Output fields: found (bool), mappedValue (string)
 *   Secret:    HUBDB_TOKEN  — private app token with HubDB read access
 * ───────────────────────────────────────────────────────────────────────────
 *
 * MIT © Nelis Smit — github.com/…/tipping-scales
 */

const hubspot = require('@hubspot/api-client');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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

      console.log(`Rate limited (429). Retry ${attempt + 1}/${retries} in ${delay}ms…`);
      await sleep(delay);
      attempt++;
    }
  }
}

exports.main = async (event, callback) => {
  // ── Configure to your table ──
  const TABLE = 'your_mapping_table';
  const COLUMN = 'lookup_key'; // column to match against
  const OUT_COLUMN = 'mapped_value'; // column whose value you want back

  const client = new hubspot.Client({ accessToken: process.env.HUBDB_TOKEN });

  try {
    const raw = event.inputFields.lookupValue;
    // Normalise before querying so it matches how the value is stored in HubDB.
    // (Example: strip a ZIP+4 suffix — "32256-1234" → "32256".)
    const value = String(raw ?? '').split('-')[0].trim().toLowerCase();

    if (!value) {
      console.log('No lookup value provided, skipping.');
      return callback({ outputFields: { found: false, mappedValue: null } });
    }

    // Server-side column filter via the REST endpoint — no 1,000-row cap.
    const resp = await withRetry(() =>
      client.apiRequest({
        method: 'GET',
        path: `/cms/v3/hubdb/tables/${TABLE}/rows`,
        qs: { [COLUMN]: value },
      })
    );

    const rows = (await resp.json()).results || [];

    // Safety layer: confirm an exact (normalised) match.
    const row = rows.find(
      (r) => r?.values && String(r.values[COLUMN] ?? '').trim().toLowerCase() === value
    );

    const mapped = row ? String(row.values[OUT_COLUMN] ?? '').trim() : '';

    if (!mapped) {
      console.log(`No mapping found for "${value}".`);
      return callback({ outputFields: { found: false, mappedValue: null } });
    }

    console.log(`Matched "${value}" → "${mapped}".`);
    return callback({ outputFields: { found: true, mappedValue: mapped } });
  } catch (err) {
    console.error('HubDB lookup failed:', err.response?.body || err);
    return callback({
      outputFields: { found: false, mappedValue: null, error: 'lookup failed — see logs' },
    });
  }
};
