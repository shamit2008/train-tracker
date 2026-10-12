-- Trackside accounts. Plain SQLite, so it runs as-is on Cloudflare D1, Turso and Node's built-in SQLite.
-- Applied by `npm run deploy` (wrangler d1 migrations apply) and by the local dev server.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- random UUID
  email         TEXT NOT NULL UNIQUE,           -- trimmed and lowercased
  password_hash TEXT NOT NULL,                  -- pbkdf2-sha256$iterations$salt$hash
  created_at    INTEGER NOT NULL                -- ms since 1970
);

-- Only a SHA-256 of each session token is stored, so a copy of this table can't be used to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- What the site syncs between devices: saved trains and stations, recent trains, display settings.
-- One JSON value per key; the newer copy of a key wins.
CREATE TABLE IF NOT EXISTS user_data (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Sign-in and sign-up attempts, for rate limiting. Rows older than a day are deleted as the worker runs.
CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_bucket ON attempts (bucket, at);
