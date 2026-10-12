/* The accounts store on any SQLite-flavoured database. The SQL lives only here and in ../../migrations;
   the database itself is reached through a client with three methods:

     all(sql, params) -> rows        rows are plain objects keyed by column name
     run(sql, params) -> { changes }
     batch([{ sql, params }])        runs the statements together, all or nothing

   Clients: d1.js (Cloudflare D1), turso.js (Turso / libSQL over HTTP), and ../../local/sqlite-client.mjs
   (Node's built-in SQLite, for the local dev server and tests). The SQL avoids anything SQLite-only beyond
   ON CONFLICT upserts, and deletes child rows itself rather than relying on foreign-key cascades. */
import { StoreError } from './errors.js';

const isUnique = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));
const userRow = (r) => (r ? { id: r.id, email: r.email, passwordHash: r.password_hash, createdAt: Number(r.created_at) } : null);

export class SqlStore {
  constructor(client) { this.db = client; }

  async createUser({ id, email, passwordHash, createdAt }) {
    try {
      await this.db.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [id, email, passwordHash, createdAt]);
    } catch (err) {
      if (isUnique(err)) throw new StoreError('email_taken');
      throw err;
    }
  }
  async getUserByEmail(email) {
    return userRow((await this.db.all('SELECT * FROM users WHERE email = ?', [email]))[0]);
  }
  async getUserById(id) {
    return userRow((await this.db.all('SELECT * FROM users WHERE id = ?', [id]))[0]);
  }
  async setPasswordHash(id, passwordHash) {
    await this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  }
  async deleteUser(id) {
    await this.db.batch([
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM user_data WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM trips WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM reset_tokens WHERE user_id = ?', params: [id] },
      { sql: 'DELETE FROM users WHERE id = ?', params: [id] },
    ]);
  }

  async createSession({ tokenHash, userId, createdAt, expiresAt }) {
    await this.db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [tokenHash, userId, createdAt, expiresAt]);
  }
  async getSession(tokenHash) {
    const r = (await this.db.all('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]))[0];
    return r ? { tokenHash: r.token_hash, userId: r.user_id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async deleteSession(tokenHash) {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }
  async deleteSessionsForUser(userId) {
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  async deleteSessionsBefore(time) {
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [time]);
  }

  async getData(userId) {
    const out = {};
    for (const r of await this.db.all('SELECT key, value, updated_at FROM user_data WHERE user_id = ?', [userId])) {
      out[r.key] = { value: JSON.parse(r.value), updatedAt: Number(r.updated_at) };
    }
    return out;
  }
  async putData(userId, entries) {
    const stmts = Object.entries(entries).map(([key, e]) => ({
      sql: `INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= user_data.updated_at`,
      params: [userId, key, JSON.stringify(e.value), e.updatedAt],
    }));
    if (stmts.length) await this.db.batch(stmts);
  }

  async listTrips(userId) {
    return (await this.db.all('SELECT * FROM trips WHERE user_id = ? ORDER BY depart_at', [userId])).map((r) => ({
      id: r.id, userId: r.user_id, provider: r.provider, num: r.train_num, date: r.service_date,
      departAt: Number(r.depart_at), data: JSON.parse(r.data), createdAt: Number(r.created_at),
    }));
  }
  async addTrip(t) {
    try {
      await this.db.run('INSERT INTO trips (id, user_id, provider, train_num, service_date, depart_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [t.id, t.userId, t.provider, t.num, t.date, t.departAt, JSON.stringify(t.data), t.createdAt]);
    } catch (err) {
      if (isUnique(err)) throw new StoreError('trip_exists');
      throw err;
    }
  }
  async deleteTrip(userId, id) {
    return (await this.db.run('DELETE FROM trips WHERE user_id = ? AND id = ?', [userId, id])).changes > 0;
  }

  async createResetToken({ tokenHash, userId, createdAt, expiresAt }) {
    await this.db.run('INSERT INTO reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [tokenHash, userId, createdAt, expiresAt]);
  }
  async getResetToken(tokenHash) {
    const r = (await this.db.all('SELECT * FROM reset_tokens WHERE token_hash = ?', [tokenHash]))[0];
    return r ? { tokenHash: r.token_hash, userId: r.user_id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async deleteResetTokensForUser(userId) {
    await this.db.run('DELETE FROM reset_tokens WHERE user_id = ?', [userId]);
  }
  async deleteResetTokensBefore(time) {
    await this.db.run('DELETE FROM reset_tokens WHERE expires_at < ?', [time]);
  }

  async countAttempts(bucket, since) {
    const r = (await this.db.all('SELECT COUNT(*) AS n FROM attempts WHERE bucket = ? AND at >= ?', [bucket, since]))[0];
    return Number(r ? r.n : 0);
  }
  async addAttempt(bucket, at) {
    await this.db.run('INSERT INTO attempts (bucket, at) VALUES (?, ?)', [bucket, at]);
  }
  async deleteAttemptsBefore(time) {
    await this.db.run('DELETE FROM attempts WHERE at < ?', [time]);
  }
}
