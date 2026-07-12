/**
 * Minimal Node adapter for crm-actions. Wires the host-agnostic core to an HTTP
 * server. Deploy this anywhere Node runs; the routes are what the app's
 * actionUrl / optionsUrl point at.
 *
 * Routes:
 *   POST /action/search        POST /action/get
 *   POST /action/delete        POST /action/batch-update
 *   POST /options              (dynamic property dropdown)
 *
 * Every request must carry ?k=<ACTION_SECRET> — the same shared secret embedded
 * in the actionUrl/optionsUrl you register in the app's hsmeta files.
 *
 * For Cloudflare Workers / Vercel / Twilio Functions, keep crm-actions.js as-is
 * and write the equivalent 15-line adapter for that runtime.
 *
 * MIT © Nelis Smit — github.com/cornelis-blip/tipping-scales
 */

'use strict';

const http = require('node:http');
const { handleAction, handleOptions } = require('./crm-actions');

const PORT = process.env.PORT || 3000;
const env = { HUBSPOT_TOKEN: process.env.HUBSPOT_TOKEN, ACTION_SECRET: process.env.ACTION_SECRET };

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Shared-secret gate.
  if (env.ACTION_SECRET && url.searchParams.get('k') !== env.ACTION_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'unauthorized' }));
  }

  const body = await readJson(req);
  let out;
  if (url.pathname === '/options') {
    out = { statusCode: 200, body: await handleOptions(body, env) };
  } else if (url.pathname.startsWith('/action/')) {
    out = await handleAction(url.pathname.slice('/action/'.length), body, env);
  } else {
    out = { statusCode: 404, body: { message: 'not found' } };
  }

  res.writeHead(out.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out.body));
});

server.listen(PORT, () => console.log(`[crm-actions] listening on :${PORT}`));
