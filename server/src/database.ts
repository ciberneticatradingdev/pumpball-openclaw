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
  const xpGain = won ? 25 : 10 + goals * 5;
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

export default pool;
