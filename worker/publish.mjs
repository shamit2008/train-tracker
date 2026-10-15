#!/usr/bin/env node
// Deploys the feeds worker to Cloudflare, stores the railroads' API keys as Worker secrets, and points the site at it.
// The first run also creates the free Cloudflare D1 database for accounts and links it in wrangler.toml;
// every run applies any new files in migrations/ before deploying.
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
// stored when ../.env has them: Metra's key (Metra is left out without it), NJ Transit's sign-in, the email service for password reset,
// and Turso if accounts move there
const OPTIONAL = ['METRA_API_KEY', 'NJT_USERNAME', 'NJT_PASSWORD', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SID', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'BREVO_API_KEY', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];

const env = {};
try {
  for (const line of (await readFile(path.join(dir, '..', '.env'), 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && (KEYS.includes(m[1]) || OPTIONAL.includes(m[1])) && m[2]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
for (const k of [...KEYS, ...OPTIONAL]) if (process.env[k]) env[k] = process.env[k];
const missing = KEYS.filter((k) => !env[k]);
if (missing.length) { console.error(`Missing ${missing.join(' and ')} in ../.env.`); process.exit(1); }

const wrangler = (args, input) => spawnSync('npx', ['wrangler', ...args], { cwd: dir, input, encoding: 'utf8', stdio: [input == null ? 'inherit' : 'pipe', 'pipe', 'pipe'] });

/* ---------------- accounts database (Cloudflare D1) ---------------- */
const DB_NAME = 'trackside-accounts';
const tomlPath = path.join(dir, 'wrangler.toml');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const hasD1 = async () => /\[\[d1_databases\]\]/.test(await readFile(tomlPath, 'utf8'));
if (/^\s*ACCOUNTS_DB\s*=\s*"d1"/m.test(await readFile(tomlPath, 'utf8')) && !(await hasD1())) {
  console.log(`Setting up the accounts database (${DB_NAME})…`);
  let id = null;
  const list = wrangler(['d1', 'list', '--json']);
  try { id = (JSON.parse(list.stdout).find((d) => d.name === DB_NAME) || {}).uuid || null; } catch { /* not JSON: not signed in, or an old wrangler */ }
  if (!id) {
    const made = wrangler(['d1', 'create', DB_NAME]);
    if (made.status !== 0) { process.stderr.write(made.stderr || ''); console.error('\nCould not create the D1 database. If you are not signed in, run: npx wrangler login'); process.exit(1); }
    id = ((made.stdout + made.stderr).match(UUID) || [])[0];
  }
  if (!(await hasD1())) {   // newer wranglers may have added the binding themselves
    if (!id) { console.error('Created the database but could not read its id. Add it to wrangler.toml by hand: see README.md.'); process.exit(1); }
    const block = `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${DB_NAME}"\ndatabase_id = "${id}"\nmigrations_dir = "migrations"\n`;
    await writeFile(tomlPath, (await readFile(tomlPath, 'utf8')).replace(/\n*$/, '\n') + block);
    console.log(`Linked D1 database ${id} in wrangler.toml.`);
  }
}
if (await hasD1()) {
  console.log('Applying database migrations…');
  const mig = wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
  process.stdout.write(mig.stdout || '');
  if (mig.status !== 0) { process.stderr.write(mig.stderr || ''); console.error('\nMigrations failed; nothing was deployed.'); process.exit(1); }
}

console.log('Deploying the worker…');
const dep = wrangler(['deploy']);
process.stdout.write(dep.stdout || '');
if (dep.status !== 0) { process.stderr.write(dep.stderr || ''); console.error('\nDeploy failed. If you are not signed in, run: npx wrangler login'); process.exit(1); }
const url = ((dep.stdout + dep.stderr).match(/https:\/\/[\w.-]+\.workers\.dev/) || [])[0];

for (const k of [...KEYS, ...OPTIONAL.filter((x) => env[x])]) {
  const r = wrangler(['secret', 'put', k], env[k]);
  if (r.status !== 0) { process.stderr.write((r.stderr || '').split(env[k]).join('…')); console.error(`\nCouldn't store ${k}.`); process.exit(1); }
  console.log(`Stored ${k} as a Worker secret.`);
}

if (!url) { console.log('\nDeployed, but I could not read the worker URL from wrangler. Put it in FEEDS_WORKER in index.html.'); process.exit(0); }
const page = path.join(dir, '..', 'index.html');
const html = await readFile(page, 'utf8');
const next = html.replace(/const FEEDS_WORKER = '[^']*';/, `const FEEDS_WORKER = '${url}';`)
  .replace(/(connect-src[^"]*?)https:\/\/[\w.-]+\.workers\.dev/, `$1${url}`);   // the page's security policy must allow it too
if (next !== html) { await writeFile(page, next); console.log(`\nindex.html now reads the commuter railroads from ${url}`); }
else console.log(`\nWorker is live at ${url} (index.html already points there).`);
console.log('Publish the site as usual (git push, or node deploy.mjs) to turn them on for everyone.');
