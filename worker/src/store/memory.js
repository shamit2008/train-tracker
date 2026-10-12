/* The accounts store in memory. For tests, and for trying the API with ACCOUNTS_DB = "memory";
   everything is lost when the worker restarts, so never use it for real accounts. */
import { StoreError } from './errors.js';

const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export class MemoryStore {
  constructor() {
    this.users = new Map();      // id -> user
    this.sessions = new Map();   // tokenHash -> session
    this.data = new Map();       // userId -> Map(key -> { value, updatedAt })
    this.attempts = [];          // [{ bucket, at }]
    this.trips = new Map();      // id -> trip
    this.resets = new Map();     // tokenHash -> reset token
  }

  async createUser(u) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw new StoreError('email_taken');
    this.users.set(u.id, { id: u.id, email: u.email, passwordHash: u.passwordHash, createdAt: u.createdAt });
  }
  async getUserByEmail(email) { return copy([...this.users.values()].find((u) => u.email === email) || null); }
  async getUserById(id) { return copy(this.users.get(id) || null); }
  async setPasswordHash(id, passwordHash) { const u = this.users.get(id); if (u) u.passwordHash = passwordHash; }
  async deleteUser(id) {
    this.users.delete(id);
    this.data.delete(id);
    for (const [k, s] of this.sessions) if (s.userId === id) this.sessions.delete(k);
    for (const [k, t] of this.trips) if (t.userId === id) this.trips.delete(k);
    for (const [k, r] of this.resets) if (r.userId === id) this.resets.delete(k);
  }

  async createSession(s) { this.sessions.set(s.tokenHash, { ...s }); }
  async getSession(tokenHash) { return copy(this.sessions.get(tokenHash) || null); }
  async deleteSession(tokenHash) { this.sessions.delete(tokenHash); }
  async deleteSessionsForUser(userId) { for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k); }
  async deleteSessionsBefore(time) { for (const [k, s] of this.sessions) if (s.expiresAt < time) this.sessions.delete(k); }

  async getData(userId) { return copy(Object.fromEntries(this.data.get(userId) || [])); }
  async putData(userId, entries) {
    if (!this.data.has(userId)) this.data.set(userId, new Map());
    const m = this.data.get(userId);
    for (const [key, e] of Object.entries(entries)) {
      const cur = m.get(key);
      if (!cur || e.updatedAt >= cur.updatedAt) m.set(key, { value: copy(e.value), updatedAt: e.updatedAt });
    }
  }

  async listTrips(userId) {
    return copy([...this.trips.values()].filter((t) => t.userId === userId).sort((a, b) => a.departAt - b.departAt));
  }
  async addTrip(t) {
    if ([...this.trips.values()].some((x) => x.userId === t.userId && x.provider === t.provider && x.num === t.num && x.date === t.date)) throw new StoreError('trip_exists');
    this.trips.set(t.id, copy(t));
  }
  async deleteTrip(userId, id) {
    const t = this.trips.get(id);
    if (!t || t.userId !== userId) return false;
    return this.trips.delete(id);
  }

  async createResetToken(r) { this.resets.set(r.tokenHash, { ...r }); }
  async getResetToken(tokenHash) { return copy(this.resets.get(tokenHash) || null); }
  async deleteResetTokensForUser(userId) { for (const [k, r] of this.resets) if (r.userId === userId) this.resets.delete(k); }
  async deleteResetTokensBefore(time) { for (const [k, r] of this.resets) if (r.expiresAt < time) this.resets.delete(k); }

  async countAttempts(bucket, since) { return this.attempts.filter((a) => a.bucket === bucket && a.at >= since).length; }
  async addAttempt(bucket, at) { this.attempts.push({ bucket, at }); }
  async deleteAttemptsBefore(time) { this.attempts = this.attempts.filter((a) => a.at >= time); }
}
