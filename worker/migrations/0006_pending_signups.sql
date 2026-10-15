-- Sign-ups waiting for the code emailed to them. The account is only made once the code comes back, so signing up
-- never reveals whether an email already has an account. One row per email; a new request replaces it.
CREATE TABLE IF NOT EXISTS pending_signups (
  email         TEXT PRIMARY KEY,
  username      TEXT,
  password_hash TEXT NOT NULL,
  code_hash     TEXT NOT NULL,                  -- SHA-256 of "email:code"
  attempts      INTEGER NOT NULL DEFAULT 0,     -- wrong codes so far
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_signups_expiry ON pending_signups (expires_at);
