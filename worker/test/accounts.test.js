/* The accounts API end to end, through the worker's fetch handler, on an in-memory SQLite database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { SqlStore } from '../src/store/sql.js';
import { sqliteClient } from '../local/sqlite-client.mjs';
import { hashPassword, verifyPassword } from '../src/accounts.js';

function server() {
  const sent = [];
  const env = {
    ALLOWED_ORIGINS: 'https://shamit2008.github.io', ACCOUNTS_STORE: new SqlStore(sqliteClient(':memory:')), PASSWORD_ITERATIONS: '1000',
    SITE_URL: 'https://shamit2008.github.io/train-tracker/', MAILER: { send: async (m) => { sent.push(m); } },
  };
  const pending = [];
  const call = async (method, path, { body, token, ip = '1.1.1.1' } = {}) => {
    const headers = { Origin: 'https://shamit2008.github.io', 'CF-Connecting-IP': ip };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://w.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { env, call, sent };
}
const creds = { email: '  Rider@Example.com ', password: 'zephyr-to-emeryville' };

test('passwords hash and verify', async () => {
  const h = await hashPassword('correct horse', 1000);
  assert.match(h, /^pbkdf2-sha256\$1000\$[\w-]{22}\$[\w-]{43}$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('correct horsf', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('sign up, sign in, sync data, sign out', async () => {
  const { call } = server();
  const up = await call('POST', '/v1/auth/signup', { body: creds });
  assert.equal(up.status, 201);
  assert.equal(up.body.user.email, 'rider@example.com');
  assert.equal(up.headers.get('Access-Control-Allow-Origin'), 'https://shamit2008.github.io');
  assert.equal(up.headers.get('Cache-Control'), 'no-store');
  assert.equal(up.body.user.passwordHash, undefined);

  assert.equal((await call('POST', '/v1/auth/signup', { body: creds })).body.error.code, 'email_taken');
  assert.equal((await call('POST', '/v1/auth/login', { body: { ...creds, password: 'wrong-password' } })).status, 401);

  const login = await call('POST', '/v1/auth/login', { body: { email: 'RIDER@example.com', password: creds.password } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await call('GET', '/v1/me', { token })).body.user.email, 'rider@example.com');

  const put = await call('PUT', '/v1/me/data', { token, body: { data: { favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 100 } } } });
  assert.deepEqual(put.body.data.favTrains.value, [{ num: '5', route: 'California Zephyr' }]);
  // an older copy from another device doesn't overwrite it, and the reply carries the newer one back
  const stale = await call('PUT', '/v1/me/data', { token: up.body.token, body: { data: { favTrains: { value: [], updatedAt: 50 } } } });
  assert.equal(stale.body.data.favTrains.value.length, 1);
  assert.equal((await call('GET', '/v1/me/data', { token })).body.data.favTrains.updatedAt, 100);

  assert.equal((await call('POST', '/v1/auth/logout', { token })).status, 204);
  assert.equal((await call('GET', '/v1/me', { token })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: up.body.token })).status, 200);   // the other device stays signed in
});

test('input is checked', async () => {
  const { call } = server();
  assert.equal((await call('POST', '/v1/auth/signup', { body: { email: 'not-an-email', password: 'long enough pw' } })).body.error.code, 'bad_email');
  assert.equal((await call('POST', '/v1/auth/signup', { body: { email: 'a@b.co', password: 'short' } })).body.error.code, 'weak_password');
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: 'made-up' })).status, 401);
  const { token } = (await call('POST', '/v1/auth/signup', { body: creds })).body;
  assert.equal((await call('PUT', '/v1/me/data', { token, body: { data: { 'bad key!': { value: 1, updatedAt: 1 } } } })).status, 400);
  assert.equal((await call('PUT', '/v1/me/data', { token, body: { data: { theme: { value: 'x'.repeat(20000), updatedAt: 1 } } } })).status, 413);
  // a far-future time is pulled back to about now, so it can't block later changes forever
  const far = await call('PUT', '/v1/me/data', { token, body: { data: { theme: { value: 'dark', updatedAt: Date.now() + 1e12 } } } });
  assert.ok(far.body.data.theme.updatedAt < Date.now() + 120000);
  const pre = await worker.fetch(new Request('https://w.example/v1/me/data', { method: 'OPTIONS', headers: { Origin: 'https://shamit2008.github.io' } }), {}, {});
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /PUT/);
});

test('repeated wrong passwords are rate limited', async () => {
  const { call } = server();
  await call('POST', '/v1/auth/signup', { body: creds });
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/v1/auth/login', { body: { ...creds, password: 'guess-' + i } })).status, 401);
  const blocked = await call('POST', '/v1/auth/login', { body: creds });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('Retry-After'));
});

test('changing the password signs out everywhere; deleting the account removes it', async () => {
  const { call } = server();
  const a = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const b = (await call('POST', '/v1/auth/login', { body: creds })).body.token;
  assert.equal((await call('POST', '/v1/me/password', { token: a, body: { password: 'nope-nope-nope', newPassword: 'new-password-1' } })).status, 403);
  const changed = await call('POST', '/v1/me/password', { token: a, body: { password: creds.password, newPassword: 'new-password-1' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/v1/me', { token: a })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: b })).status, 401);
  const c = changed.body.token;
  assert.equal((await call('GET', '/v1/me', { token: c })).status, 200);

  await call('PUT', '/v1/me/data', { token: c, body: { data: { theme: { value: 'dark', updatedAt: 1 } } } });
  assert.equal((await call('DELETE', '/v1/me', { token: c, body: { password: 'wrong-wrong' } })).status, 403);
  assert.equal((await call('DELETE', '/v1/me', { token: c, body: { password: 'new-password-1' } })).status, 204);
  assert.equal((await call('GET', '/v1/me', { token: c })).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: creds.email, password: 'new-password-1' } })).status, 401);
  assert.equal((await call('POST', '/v1/auth/signup', { body: creds })).status, 201);   // the email can sign up again
});

test('without a database configured, accounts answer 503 and the feeds still work', async () => {
  const res = await worker.fetch(new Request('https://w.example/v1/me'), {}, { waitUntil() {} });
  assert.equal(res.status, 503);
  assert.equal((await worker.fetch(new Request('https://w.example/v1/stations'), {}, { waitUntil() {} })).status, 200);
});

test('password reset by email', async () => {
  const { call, sent } = server();
  const old = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;

  // the answer doesn't reveal whether an account exists
  const none = await call('POST', '/v1/auth/reset', { body: { email: 'nobody@example.com' } });
  assert.equal(none.status, 202);
  assert.equal(sent.length, 0);
  const asked = await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal(asked.status, 202);
  assert.deepEqual(asked.body, none.body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rider@example.com');
  const link = /https:\/\/shamit2008\.github\.io\/train-tracker\/#reset=([\w-]+)/.exec(sent[0].text);
  assert.ok(link, 'the email carries a link to the site');
  assert.ok(sent[0].html.includes(link[0]));

  // asking again replaces the link
  await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  const token = /#reset=([\w-]+)/.exec(sent[1].text)[1];
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token: link[1], password: 'brand-new-password' } })).body.error.code, 'bad_token');
  // a short password doesn't use up the link
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'short' } })).body.error.code, 'weak_password');
  const done = await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'brand-new-password' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.email, 'rider@example.com');
  assert.equal((await call('GET', '/v1/me', { token: done.body.token })).status, 200);
  assert.equal((await call('GET', '/v1/me', { token: old })).status, 401);   // signed out everywhere else
  assert.equal((await call('POST', '/v1/auth/reset/confirm', { body: { token, password: 'another-password' } })).status, 400);   // works once
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: creds.email, password: 'brand-new-password' } })).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', { body: creds })).status, 401);

  // a few requests an hour per email at most
  await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal((await call('POST', '/v1/auth/reset', { body: { email: creds.email } })).status, 429);
});

test('password reset without email set up answers 503', async () => {
  const { env, call } = server();
  delete env.MAILER;
  const r = await call('POST', '/v1/auth/reset', { body: { email: creds.email } });
  assert.equal(r.status, 503);
});

test('trips', async () => {
  const { call } = server();
  const token = (await call('POST', '/v1/auth/signup', { body: creds })).body.token;
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const at = Date.parse(day + 'T19:00:00Z');
  const zephyr = { provider: 'Amtrak', num: '5', date: day, route: 'California Zephyr',
    from: { code: 'CHI', name: 'Chicago Union Station', at, tz: 'America/Chicago' },
    to: { code: 'DEN', name: 'Denver', at: at + 18 * 3600000, tz: 'America/Denver' } };

  assert.equal((await call('POST', '/v1/me/trips', { body: zephyr })).status, 401);
  const added = await call('POST', '/v1/me/trips', { token, body: zephyr });
  assert.equal(added.status, 201);
  assert.equal(added.body.trip.route, 'California Zephyr');
  assert.equal(added.body.trip.to.code, 'DEN');
  assert.equal((await call('POST', '/v1/me/trips', { token, body: zephyr })).body.error.code, 'trip_exists');
  const earlier = await call('POST', '/v1/me/trips', { token, body: { ...zephyr, num: '7', from: { ...zephyr.from, at: at - 3600000 } } });
  assert.equal(earlier.status, 201);

  const list = await call('GET', '/v1/me/trips', { token });
  assert.deepEqual(list.body.trips.map((t) => t.num), ['7', '5']);

  const bad = (b) => call('POST', '/v1/me/trips', { token, body: { ...zephyr, num: '9', ...b } });
  assert.equal((await bad({ provider: 'Hogwarts Express' })).status, 400);
  assert.equal((await bad({ date: '2020-01-01' })).status, 400);
  assert.equal((await bad({ to: { ...zephyr.to, at: at - 1 } })).status, 400);
  assert.equal((await bad({ num: '<script>' })).status, 400);

  assert.equal((await call('DELETE', '/v1/me/trips/' + added.body.trip.id, { token })).status, 204);
  assert.equal((await call('DELETE', '/v1/me/trips/' + added.body.trip.id, { token })).status, 404);
  assert.deepEqual((await call('GET', '/v1/me/trips', { token })).body.trips.map((t) => t.num), ['7']);
});
