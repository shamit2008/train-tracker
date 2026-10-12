-- Trips people plan (a train on a given day, between two of its stations) and password-reset links.

CREATE TABLE IF NOT EXISTS trips (
  id           TEXT PRIMARY KEY,               -- random UUID
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,                  -- Amtrak, Via, Brightline, Metrolink or Caltrain, as the live feeds name them
  train_num    TEXT NOT NULL,
  service_date TEXT NOT NULL,                  -- YYYY-MM-DD the train starts its run, in its first station's time zone
  depart_at    INTEGER NOT NULL,               -- scheduled departure from the trip's first station, ms since 1970
  data         TEXT NOT NULL,                  -- JSON: route name, boarding and leaving stations and times
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_per_train ON trips (user_id, provider, train_num, service_date);
CREATE INDEX IF NOT EXISTS trips_user ON trips (user_id, depart_at);

-- Only a SHA-256 of each emailed token is stored. Each lasts 30 minutes and works once.
CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reset_tokens_user ON reset_tokens (user_id);
