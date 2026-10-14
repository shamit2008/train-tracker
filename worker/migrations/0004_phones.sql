-- Phone numbers, so friends can find each other by number or from their phone's contacts.
-- Contacts are matched by a SHA-256 of the number (E.164, like +15551234567), so the app never sends anyone's
-- contacts as plain numbers. The number itself is kept only to show its owner what they entered.

CREATE TABLE IF NOT EXISTS phones (
  user_id    TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,                     -- E.164
  phone_hash TEXT NOT NULL UNIQUE               -- lowercase hex SHA-256 of phone
);
