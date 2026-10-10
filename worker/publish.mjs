#!/usr/bin/env node
// Deploys the feeds worker to Cloudflare, stores both API keys as Worker secrets, and points the site at it.
//
//   npx wrangler login     (once: opens a browser to sign in to Cloudflare)
//   npm run deploy
//
// Keys are read from ../.env and piped to `wrangler secret put` on stdin, so they never appear in a command line,
// in this repo or in index.html. Afterwards the site only knows the worker's public URL.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const KEYS = ['METROLINK_API_KEY', 'CALTRAIN_511_KEY'];

const env = {};
try {
  for (const line of (await readFile(path.join(dir, '..', '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && KEYS.includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
for (const k of KEYS) if (process.env[k]) env[k] = process.env[k];
const missing = KEYS.filter((k) => !env[k]);
if (missing.length) { console.error(`Missing ${missing.join(' and ')} in ../.env.`); process.exit(1); }

const wrangler = (args, input) => spawnSync('npx', ['wrangler', ...args], { cwd: dir, input, encoding: 'utf8', stdio: [input == null ? 'inherit' : 'pipe', 'pipe', 'pipe'] });

console.log('Deploying the worker…');
const dep = wrangler(['deploy']);
process.stdout.write(dep.stdout || '');
if (dep.status !== 0) { process.stderr.write(dep.stderr || ''); console.error('\nDeploy failed. If you are not signed in, run: npx wrangler login'); process.exit(1); }
const url = ((dep.stdout + dep.stderr).match(/https:\/\/[\w.-]+\.workers\.dev/) || [])[0];

for (const k of KEYS) {
  const r = wrangler(['secret', 'put', k], env[k]);
  if (r.status !== 0) { process.stderr.write((r.stderr || '').split(env[k]).join('…')); console.error(`\nCouldn't store ${k}.`); process.exit(1); }
  console.log(`Stored ${k} as a Worker secret.`);
}

if (!url) { console.log('\nDeployed, but I could not read the worker URL from wrangler. Put it in FEEDS_WORKER in index.html.'); process.exit(0); }
const page = path.join(dir, '..', 'index.html');
const html = await readFile(page, 'utf8');
const next = html.replace(/const FEEDS_WORKER = '[^']*';/, `const FEEDS_WORKER = '${url}';`);
if (next !== html) { await writeFile(page, next); console.log(`\nindex.html now reads Metrolink and Caltrain from ${url}`); }
else console.log(`\nWorker is live at ${url} (index.html already points there).`);
console.log('Publish the site as usual (git push, or node deploy.mjs) to turn them on for everyone.');
