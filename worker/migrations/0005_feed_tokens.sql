-- Feed sign-in tokens, kept so a daily-limited sign-in (NJ Transit allows 10 a day) isn't repeated by every
-- instance of the worker. One row per railroad.
CREATE TABLE IF NOT EXISTS feed_tokens (
  name       TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
