CREATE TABLE races (
  id SERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  race_number INTEGER NOT NULL,
  total_spots INTEGER NOT NULL,
  remaining_spots INTEGER NOT NULL,
  closed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(channel_id, race_number)
);

CREATE TABLE entries (
  id SERIAL PRIMARY KEY,
  race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL
);

CREATE TABLE race_thresholds (
  race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
  threshold INTEGER NOT NULL
);
