/* The accounts-store contract. Every adapter must pass the same checks; a new adapter gets added to ADAPTERS.
   Cloudflare D1 can't run here, but it shares SqlStore and its SQL with the SQLite adapters below. Turso runs its
   real client against a local stand-in for Turso's HTTP API (local/fake-turso.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { SqlStore } from '../src/store/sql.js';
import { StoreError } from '../src/store/errors.js';
import { tursoClient } from '../src/store/turso.js';
import { sqliteClient } from '../local/sqlite-client.mjs';
import { fakeTursoFetch } from '../local/fake-turso.mjs';

/* turso.js calls the global fetch; each Turso store gets its own fake database, chosen by URL. */
const tursoDbs = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const db = tursoDbs.get(new URL(url).host);
  return db ? db(url, init) : realFetch(url, init);
};
function fakeTurso() {
  const host = `db${tursoDbs.size}-test.turso.io`;
  tursoDbs.set(host, fakeTursoFetch('tok'));
  return new SqlStore(tursoClient(`libsql://${host}`, 'tok'));
}

const ADAPTERS = {
  memory: () => new MemoryStore(),
  'sql on node:sqlite': () => new SqlStore(sqliteClient(':memory:')),
  'sql on turso (local stand-in)': fakeTurso,
};

test('turso: a failing statement rolls back the whole batch', async () => {
  const s = fakeTurso();
  await s.createUser({ id: 'u1', email: 'a@example.com', passwordHash: 'h', createdAt: 1 });
  await assert.rejects(s.db.batch([
    { sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', params: ['u2', 'b@example.com', 'h', 2] },
    { sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', params: ['u3', 'a@example.com', 'h', 3] },
  ]), /UNIQUE/);
  assert.equal(await s.getUserById('u2'), null);
});

for (const [name, make] of Object.entries(ADAPTERS)) {
  const user = (n = 1) => ({ id: 'u' + n, email: `p${n}@example.com`, passwordHash: 'hash' + n, createdAt: 1000 + n });

  test(`${name}: users`, async () => {
    const s = make();
    await s.createUser(user(1));
    assert.deepEqual(await s.getUserByEmail('p1@example.com'), user(1));
    assert.deepEqual(await s.getUserById('u1'), user(1));
    assert.equal(await s.getUserByEmail('nobody@example.com'), null);
    assert.equal(await s.getUserById('nope'), null);
    await assert.rejects(s.createUser({ ...user(2), email: 'p1@example.com' }), (e) => e instanceof StoreError && e.code === 'email_taken');
    await s.setPasswordHash('u1', 'newhash');
    assert.equal((await s.getUserById('u1')).passwordHash, 'newhash');
  });

  test(`${name}: sessions`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    await s.createSession({ tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createSession({ tokenHash: 'b', userId: 'u1', createdAt: 1, expiresAt: 300 });
    await s.createSession({ tokenHash: 'c', userId: 'u2', createdAt: 1, expiresAt: 300 });
    assert.deepEqual(await s.getSession('a'), { tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.deleteSessionsBefore(200);
    assert.equal(await s.getSession('a'), null);
    assert.ok(await s.getSession('b'));
    await s.deleteSessionsForUser('u1');
    assert.equal(await s.getSession('b'), null);
    assert.ok(await s.getSession('c'));
    await s.deleteSession('c');
    assert.equal(await s.getSession('c'), null);
  });

  test(`${name}: data keeps the newer copy of each key`, async () => {
    const s = make();
    await s.createUser(user(1));
    assert.deepEqual(await s.getData('u1'), {});
    await s.putData('u1', { favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 10 }, theme: { value: 'dark', updatedAt: 10 } });
    await s.putData('u1', { favTrains: { value: [], updatedAt: 5 }, theme: { value: 'light', updatedAt: 20 } });
    assert.deepEqual(await s.getData('u1'), {
      favTrains: { value: [{ num: '5', route: 'California Zephyr' }], updatedAt: 10 },
      theme: { value: 'light', updatedAt: 20 },
    });
    await s.putData('u1', {});
    // values round-trip as JSON: numbers, booleans, null, nesting
    await s.putData('u1', { misc: { value: { a: 1, b: true, c: null, d: [1.5, 'x'] }, updatedAt: 1 } });
    assert.deepEqual((await s.getData('u1')).misc.value, { a: 1, b: true, c: null, d: [1.5, 'x'] });
  });

  test(`${name}: deleting a user deletes their sessions and data`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    await s.createSession({ tokenHash: 'a', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createSession({ tokenHash: 'c', userId: 'u2', createdAt: 1, expiresAt: 100 });
    await s.putData('u1', { theme: { value: 'dark', updatedAt: 1 } });
    await s.putData('u2', { theme: { value: 'light', updatedAt: 1 } });
    await s.deleteUser('u1');
    assert.equal(await s.getUserById('u1'), null);
    assert.equal(await s.getSession('a'), null);
    assert.deepEqual(await s.getData('u1'), {});
    assert.ok(await s.getUserById('u2'));
    assert.ok(await s.getSession('c'));
    assert.equal((await s.getData('u2')).theme.value, 'light');
    await s.createUser({ ...user(3), email: 'p1@example.com' });   // the email is free again
  });

  test(`${name}: trips`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createUser(user(2));
    const trip = (id, userId, num, date, departAt) => ({ id, userId, provider: 'Amtrak', num, date, departAt, data: { route: 'R', from: { code: 'CHI' }, to: { code: 'DEN' } }, createdAt: 1 });
    await s.addTrip(trip('t2', 'u1', '5', '2026-10-20', 2000));
    await s.addTrip(trip('t1', 'u1', '6', '2026-10-18', 1000));
    await s.addTrip(trip('t3', 'u2', '5', '2026-10-20', 2000));   // someone else can take the same train
    await assert.rejects(s.addTrip(trip('t4', 'u1', '5', '2026-10-20', 2000)), (e) => e instanceof StoreError && e.code === 'trip_exists');
    const mine = await s.listTrips('u1');
    assert.deepEqual(mine.map((t) => t.id), ['t1', 't2']);   // soonest first
    assert.deepEqual(mine[1], trip('t2', 'u1', '5', '2026-10-20', 2000));
    assert.equal(await s.deleteTrip('u2', 't1'), false);   // not theirs
    assert.equal(await s.deleteTrip('u1', 't1'), true);
    assert.equal(await s.deleteTrip('u1', 't1'), false);
    await s.deleteUser('u1');
    assert.deepEqual(await s.listTrips('u1'), []);
    assert.equal((await s.listTrips('u2')).length, 1);
  });

  test(`${name}: reset tokens`, async () => {
    const s = make();
    await s.createUser(user(1));
    await s.createResetToken({ tokenHash: 'r1', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.createResetToken({ tokenHash: 'r2', userId: 'u1', createdAt: 2, expiresAt: 300 });
    assert.deepEqual(await s.getResetToken('r1'), { tokenHash: 'r1', userId: 'u1', createdAt: 1, expiresAt: 100 });
    await s.deleteResetTokensBefore(200);
    assert.equal(await s.getResetToken('r1'), null);
    assert.ok(await s.getResetToken('r2'));
    await s.deleteResetTokensForUser('u1');
    assert.equal(await s.getResetToken('r2'), null);
  });

  test(`${name}: attempts`, async () => {
    const s = make();
    for (const at of [10, 20, 30]) await s.addAttempt('login-email:p1@example.com', at);
    await s.addAttempt('login-ip:1.2.3.4', 30);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 0), 3);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 20), 2);
    assert.equal(await s.countAttempts('other', 0), 0);
    await s.deleteAttemptsBefore(25);
    assert.equal(await s.countAttempts('login-email:p1@example.com', 0), 1);
    assert.equal(await s.countAttempts('login-ip:1.2.3.4', 0), 1);
  });
}
