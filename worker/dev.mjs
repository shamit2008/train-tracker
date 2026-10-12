#!/usr/bin/env node
// Runs the worker on http://localhost:8787 with plain Node, using the keys in ../.env.
// Handy for trying the site locally without a Cloudflare account. Keys stay in this process.
// Accounts are kept in .accounts-dev.sqlite here (git-ignored), through the same store code D1 uses.
// Password-reset emails aren't sent: they're printed here, link and all.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from './src/index.js';
import { SECRET_KEYS } from './src/agencies.js';
import { SqlStore } from './src/store/sql.js';
import { sqliteClient } from './local/sqlite-client.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = {
  ALLOWED_ORIGINS: 'null',
  ACCOUNTS_STORE: new SqlStore(sqliteClient(path.join(dir, '.accounts-dev.sqlite'))),
  MAIL_PROVIDER: 'log',
  SITE_URL: process.env.SITE_URL || 'http://localhost:8000/',   // where you serve index.html locally
};
try {
  for (const line of (await readFile(path.join(dir, '..', '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && SECRET_KEYS.includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
for (const k of SECRET_KEYS) if (process.env[k]) env[k] = process.env[k];

const port = Number(process.env.PORT) || 8787;
createServer(async (req, res) => {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  await Promise.allSettled(pending);
}).listen(port, () => {
  console.log(`Trackside feeds on http://localhost:${port}/v1/trains`);
  for (const k of SECRET_KEYS) if (!env[k]) console.log(`  (no ${k} in ../.env: that railroad will be empty)`);
});
