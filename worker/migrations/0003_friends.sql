-- Usernames, so people can find each other, and friendships, so friends can see each other's trips.
-- Usernames live in their own table rather than a new users column: SQLite has no ADD COLUMN IF NOT EXISTS,
-- and every migration here must be safe to re-run (the local dev server applies them all on each start).

CREATE TABLE IF NOT EXISTS profiles (
  user_id  TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE                 -- lowercase letters, digits and underscores
);

-- One row per pair of people, whoever asked first. Accepted friends see each other's trips.
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status       TEXT NOT NULL,                   -- 'pending' or 'accepted'
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee_id);
