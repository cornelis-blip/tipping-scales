#!/usr/bin/env node
/**
 * CLI runner for bulk-associations.
 *
 * Reads a list of "fromId,toId" pairs (a file or stdin) and creates or removes
 * associations in bulk via the v4 batch API.
 *
 * SAFE BY DEFAULT: runs as a DRY RUN unless you pass --commit. Archiving
 * associations is not reversible — look at the dry-run summary first.
 *
 * Examples:
 *   # Preview creating default contact→company associations from a file:
 *   HUBSPOT_TOKEN=pat-xxx node run.js --create --from contacts --to companies --label default --file pairs.csv
 *
 *   # Actually remove ALL associations between the listed pairs:
 *   HUBSPOT_TOKEN=pat-xxx node run.js --archive --from contacts --to companies --file pairs.csv --commit
 *
 *   # Remove only a specific labeled association, keeping others:
 *   HUBSPOT_TOKEN=pat-xxx node run.js --archive-label --from deals --to contacts --label "Decision maker" --file pairs.csv --commit
 *
 * pairs.csv is one pair per line: `12345,67890` (a header row is ignored).
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const fs = require('node:fs');
const {
  parsePairs,
  resolveType,
  batchCreate,
  batchArchive,
  batchArchiveLabeled,
} = require('./bulk-associations');

function parseArgs(argv) {
  const args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--create' || a === '--archive' || a === '--archive-label') args.mode = a.slice(2);
    else if (a === '--commit') args.commit = true;
    else if (a === '--from') args.fromType = argv[++i];
    else if (a === '--to') args.toType = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--category') args.category = argv[++i];
    else if (a === '--type-id') args.typeId = Number(argv[++i]);
  }
  return args;
}

function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  try {
    return fs.readFileSync(0, 'utf8'); // stdin
  } catch {
    return '';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.HUBSPOT_TOKEN;

  if (!token) fail('Set HUBSPOT_TOKEN (a private app token with CRM object read/write scopes).');
  if (!args.mode) fail('Choose one of: --create | --archive | --archive-label');
  if (!args.fromType || !args.toType) fail('Provide --from <objectType> and --to <objectType>.');

  const pairs = parsePairs(readInput(args.file));
  if (!pairs.length) fail('No valid "fromId,toId" pairs found in input.');

  const ctx = { token, dryRun: !args.commit };
  const common = { fromType: args.fromType, toType: args.toType, pairs };

  console.log(`${ctx.dryRun ? '[DRY RUN] ' : ''}${args.mode} ${pairs.length} pair(s): ${args.fromType} → ${args.toType}`);

  let summary;
  if (args.mode === 'archive') {
    summary = await batchArchive(common, ctx);
  } else {
    // create / archive-label need an association type
    const type =
      args.typeId != null
        ? { associationCategory: args.category || 'USER_DEFINED', associationTypeId: args.typeId }
        : await resolveType({ fromType: args.fromType, toType: args.toType, label: args.label }, ctx);
    summary =
      args.mode === 'create'
        ? await batchCreate({ ...common, type }, ctx)
        : await batchArchiveLabeled({ ...common, type }, ctx);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (ctx.dryRun) console.log('\nDry run only. Re-run with --commit to apply.');
  if (summary.failed) process.exitCode = 1;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(2);
}

main().catch((err) => fail(err.message));
