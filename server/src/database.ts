import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not set — database features disabled');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Railway requires SSL
      max: 10,
    })
  : null;

export type User = {
  id: string;
  wallet_address: string;
  username: string;
  avatar_data: string | null; // base64 encoded avatar
  xp: number;
  level: number;
  games_played: number;
  games_won: number;
  goals_scored: number;
  created_at: string;
  updated_at: string;
};

// Initialize tables
export async function initDB(): Promise<void> {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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

    CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);

    -- XP ledger: every XP gain is recorded with a timestamp so we can compute
    -- the rolling 24h XP per player for the daily token distribution.
    CREATE TABLE IF NOT EXISTS xp_events (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'game',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_xp_events_created ON xp_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id);

    -- Room-specific wins for manual rewards (e.g. PUMP-1 1v1 ranked matches)
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
  `);

  console.log('✅ Database tables ready');
}

export async function getOrCreateUser(walletAddress: string): Promise<User | null> {
  if (!pool) return null;

  // Try to find existing
  const existing = await pool.query(
    'SELECT * FROM users WHERE wallet_address = $1',
    [walletAddress],
  );

  if (existing.rows.length > 0) return existing.rows[0];

  // Create new
  const shortName = 'Player_' + walletAddress.slice(0, 4);
  const result = await pool.query(
    'INSERT INTO users (wallet_address, username) VALUES ($1, $2) RETURNING *',
    [walletAddress, shortName],
  );

  return result.rows[0] || null;
}

export async function getUserById(id: string): Promise<User | null> {
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getUserByWallet(wallet: string): Promise<User | null> {
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM users WHERE wallet_address = $1', [wallet]);
  return result.rows[0] || null;
}

export async function setUsername(userId: string, username: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
    [username.trim().slice(0, 20), userId],
  );
}

export async function setAvatar(userId: string, avatarData: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE users SET avatar_data = $1, updated_at = NOW() WHERE id = $2',
    [avatarData, userId],
  );
}

export async function addGameStats(userId: string, won: boolean, goals: number): Promise<void> {
  if (!pool) return;
  // XP model: base for playing + win bonus + per-goal bonus
  const PLAY_XP = 10;
  const WIN_XP = 25;
  const GOAL_XP = 5;
  const xpGain = PLAY_XP + (won ? WIN_XP : 0) + goals * GOAL_XP;

  await pool.query(
    `UPDATE users SET
      games_played = games_played + 1,
      games_won = games_won + $1,
      goals_scored = goals_scored + $2,
      xp = xp + $3,
      level = GREATEST(1, (xp + $3) / 100 + 1),
      updated_at = NOW()
    WHERE id = $4`,
    [won ? 1 : 0, goals, xpGain, userId],
  );

  // Record in the rolling ledger for daily token distribution
  await pool.query(
    `INSERT INTO xp_events (user_id, amount, reason) VALUES ($1, $2, $3)`,
    [userId, xpGain, won ? 'win' : 'game'],
  );
}

export async function getLeaderboard(limit = 20): Promise<Partial<User>[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, wallet_address, username, avatar_data, xp, level,
            games_played, games_won, goals_scored
     FROM users ORDER BY xp DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export type RoomWin = {
  id: number;
  room_code: string;
  winner_team: string;
  winner_wallet: string;
  winner_username: string | null;
  score_red: number;
  score_blue: number;
  rewarded: boolean;
  created_at: string;
};

export async function recordRoomWin(
  roomCode: string,
  winnerTeam: string,
  winnerWallet: string,
  winnerUsername: string,
  scoreRed: number,
  scoreBlue: number,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO room_wins (room_code, winner_team, winner_wallet, winner_username, score_red, score_blue)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [roomCode, winnerTeam, winnerWallet, winnerUsername, scoreRed, scoreBlue],
  );
}

export async function getRoomWins(roomCode: string, onlyUnrewarded = false, limit = 100): Promise<RoomWin[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT * FROM room_wins
     WHERE room_code = $1 ${onlyUnrewarded ? 'AND rewarded = FALSE' : ''}
     ORDER BY created_at DESC
     LIMIT $2`,
    [roomCode, limit],
  );
  return result.rows;
}

export async function markRoomWinRewarded(winId: number): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE room_wins SET rewarded = TRUE WHERE id = $1',
    [winId],
  );
}

// ===== DAILY TOKEN REWARDS =====
// 1,000,000 $PUMPBALL distributed every 24h, split pro-rata by XP earned in the
// trailing 24h window, until the World Cup final (2026-07-19).

export type RewardRow = {
  user_id: string;
  wallet_address: string;
  username: string;
  avatar_data: string | null;
  xp_24h: number;
};

// Returns players ranked by XP earned in the trailing `hours` window.
export async function getRecentXpLeaderboard(hours = 24, limit = 100): Promise<RewardRow[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT u.id AS user_id, u.wallet_address, u.username, u.avatar_data,
            COALESCE(SUM(e.amount), 0)::int AS xp_24h
     FROM xp_events e
     JOIN users u ON u.id = e.user_id
     WHERE e.created_at >= NOW() - ($1 || ' hours')::interval
     GROUP BY u.id, u.wallet_address, u.username, u.avatar_data
     HAVING COALESCE(SUM(e.amount), 0) > 0
     ORDER BY xp_24h DESC
     LIMIT $2`,
    [hours, limit],
  );
  return result.rows;
}

// Total XP earned across all players in the trailing window (denominator).
export async function getTotalRecentXp(hours = 24): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS total
     FROM xp_events
     WHERE created_at >= NOW() - ($1 || ' hours')::interval`,
    [hours],
  );
  return result.rows[0]?.total ?? 0;
}

export default pool;
