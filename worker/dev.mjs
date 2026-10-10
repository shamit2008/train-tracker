#!/usr/bin/env node
// Runs the worker on http://localhost:8787 with plain Node, using the keys in ../.env.
// Handy for trying the site locally without a Cloudflare account. Keys stay in this process.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from './src/index.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = { ALLOWED_ORIGINS: 'null' };
try {
  for (const line of (await readFile(path.join(dir, '..', '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*(METROLINK_API_KEY|CALTRAIN_511_KEY)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
for (const k of ['METROLINK_API_KEY', 'CALTRAIN_511_KEY']) if (process.env[k]) env[k] = process.env[k];

const port = Number(process.env.PORT) || 8787;
createServer(async (req, res) => {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  await Promise.allSettled(pending);
}).listen(port, () => {
  console.log(`Trackside feeds on http://localhost:${port}/v1/trains`);
  for (const k of ['METROLINK_API_KEY', 'CALTRAIN_511_KEY']) if (!env[k]) console.log(`  (no ${k} in ../.env: that operator will be empty)`);
});
