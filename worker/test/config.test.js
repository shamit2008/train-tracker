/* The deployed settings have to agree with each other. The site runs on one origin and the feeds worker answers only the
   origins it allows, so a site moved to a new address must be added to ALLOWED_ORIGINS, or its commuter railroads vanish. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const toml = await readFile(path.join(dir, '..', 'wrangler.toml'), 'utf8');
const setting = (name) => (toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1];

test('the site origin is among the worker\'s ALLOWED_ORIGINS', () => {
  const site = new URL(setting('SITE_URL')).origin;
  const allowed = setting('ALLOWED_ORIGINS').split(',').map((s) => s.trim());
  assert.ok(allowed.includes(site), `SITE_URL is ${site}, but ALLOWED_ORIGINS is ${allowed.join(', ')}`);
});
