-- PumpBall tables (using pumpball_ prefix to avoid conflicts with randompips tables)

CREATE TABLE IF NOT EXISTS pumpball_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL DEFAULT 'Player',
  avatar_data TEXT DEFAULT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0,
  goals_scored INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pumpball_users_wallet ON pumpball_users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_pumpball_users_xp ON pumpball_users(xp DESC);

CREATE TABLE IF NOT EXISTS pumpball_xp_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES pumpball_users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'game',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pumpball_xp_events_created ON pumpball_xp_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pumpball_xp_events_user ON pumpball_xp_events(user_id);

CREATE TABLE IF NOT EXISTS room_wins (
  id BIGSERIAL PRIMARY KEY,
  room_code TEXT NOT NULL,
  winner_team TEXT NOT NULL,
  winner_wallet TEXT NOT NULL,
  winner_username TEXT,
  score_red INTEGER NOT NULL DEFAULT 0,
  score_blue INTEGER NOT NULL DEFAULT 0,
  rewarded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_room_wins_code ON room_wins(room_code);
CREATE INDEX IF NOT EXISTS idx_room_wins_rewarded ON room_wins(rewarded);
CREATE INDEX IF NOT EXISTS idx_room_wins_created ON room_wins(created_at DESC);
