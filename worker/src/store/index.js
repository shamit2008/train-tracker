/* The accounts store: everything Trackside keeps about people, behind one small interface, so the database
   behind it can be swapped without touching the API or the site.

   An adapter is any object with these async methods. Times are milliseconds since 1970.

     createUser({ id, email, passwordHash, createdAt })      throws StoreError('email_taken') if the email exists
     getUserByEmail(email) -> user | null                     user: { id, email, passwordHash, createdAt }
     getUserById(id) -> user | null
     setPasswordHash(id, passwordHash)
     deleteUser(id)                                           also deletes that user's sessions, data, trips and reset links

     createSession({ tokenHash, userId, createdAt, expiresAt })
     getSession(tokenHash) -> { tokenHash, userId, createdAt, expiresAt } | null
     deleteSession(tokenHash)
     deleteSessionsForUser(userId)                            signs a person out everywhere
     deleteSessionsBefore(time)                               housekeeping: drops expired sessions

     getData(userId) -> { [key]: { value, updatedAt } }       value is any JSON
     putData(userId, { [key]: { value, updatedAt } })         per key, keeps whichever copy is newer

     listTrips(userId) -> [trip]                              trip: { id, userId, provider, num, date, departAt, data, createdAt }
     addTrip(trip)                                            throws StoreError('trip_exists') for the same train on the same day
     deleteTrip(userId, id) -> boolean                        false if there was no such trip

     createResetToken({ tokenHash, userId, createdAt, expiresAt })
     getResetToken(tokenHash) -> { tokenHash, userId, createdAt, expiresAt } | null
     deleteResetTokensForUser(userId)                         a link works once: using one cancels them all
     deleteResetTokensBefore(time)

     countAttempts(bucket, since) -> number                   rate limiting: sign-in and sign-up attempts
     addAttempt(bucket, at)
     deleteAttemptsBefore(time)

   Adapters here: SQL databases through sql.js (Cloudflare D1, Turso, or Node's built-in SQLite for local
   runs), and an in-memory one. test/store.test.js runs the same checks against each of them. */
import { SqlStore } from './sql.js';
import { d1Client } from './d1.js';
import { tursoClient } from './turso.js';
import { MemoryStore } from './memory.js';

export { StoreError } from './errors.js';

/* Picks the adapter from the worker's settings:
     ACCOUNTS_STORE   an adapter object handed in directly (local dev server, tests)
     ACCOUNTS_DB      "d1" (the DB binding), "turso" (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) or "memory"
   Returns null when accounts aren't configured, and the API answers 503. */
const built = new WeakMap();
export function storeFor(env) {
  if (env.ACCOUNTS_STORE) return env.ACCOUNTS_STORE;
  if (built.has(env)) return built.get(env);
  const kind = String(env.ACCOUNTS_DB || (env.DB ? 'd1' : '')).toLowerCase();
  let store = null;
  if (kind === 'd1' && env.DB) store = new SqlStore(d1Client(env.DB));
  else if (kind === 'turso' && env.TURSO_DATABASE_URL) store = new SqlStore(tursoClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN));
  else if (kind === 'memory') store = memory || (memory = new MemoryStore());   // one per isolate; lost on restart
  built.set(env, store);
  return store;
}
let memory = null;
