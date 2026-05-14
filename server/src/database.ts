import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pumpball.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    wallet_address TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL DEFAULT 'Player',
    avatar_url TEXT DEFAULT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    games_played INTEGER NOT NULL DEFAULT 0,
    games_won INTEGER NOT NULL DEFAULT 0,
    goals_scored INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
  CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);
`);

export type User = {
  id: string;
  wallet_address: string;
  username: string;
  avatar_url: string | null;
  xp: number;
  level: number;
  games_played: number;
  games_won: number;
  goals_scored: number;
  created_at: string;
  updated_at: string;
};

// Prepared statements
const findByWallet = db.prepare('SELECT * FROM users WHERE wallet_address = ?');
const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT INTO users (id, wallet_address, username)
  VALUES (?, ?, ?)
`);
const updateUsername = db.prepare(`
  UPDATE users SET username = ?, updated_at = datetime('now') WHERE id = ?
`);
const updateAvatar = db.prepare(`
  UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?
`);
const updateStats = db.prepare(`
  UPDATE users SET
    games_played = games_played + ?,
    games_won = games_won + ?,
    goals_scored = goals_scored + ?,
    xp = xp + ?,
    level = MAX(1, (xp + ?) / 100 + 1),
    updated_at = datetime('now')
  WHERE id = ?
`);
const topPlayers = db.prepare(`
  SELECT id, wallet_address, username, avatar_url, xp, level, games_played, games_won, goals_scored
  FROM users ORDER BY xp DESC LIMIT ?
`);

export function getOrCreateUser(walletAddress: string): User {
  let user = findByWallet.get(walletAddress) as User | undefined;
  if (user) return user;

  const id = uuidv4();
  const shortName = 'Player_' + walletAddress.slice(0, 4);
  insertUser.run(id, walletAddress, shortName);
  return findByWallet.get(walletAddress) as User;
}

export function getUserById(id: string): User | undefined {
  return findById.get(id) as User | undefined;
}

export function getUserByWallet(wallet: string): User | undefined {
  return findByWallet.get(wallet) as User | undefined;
}

export function setUsername(userId: string, username: string): void {
  updateUsername.run(username.trim().slice(0, 20), userId);
}

export function setAvatar(userId: string, avatarUrl: string): void {
  updateAvatar.run(avatarUrl, userId);
}

export function addGameStats(userId: string, won: boolean, goals: number): void {
  const xpGain = won ? 25 : 10 + goals * 5;
  updateStats.run(1, won ? 1 : 0, goals, xpGain, xpGain, userId);
}

export function getLeaderboard(limit = 20): Partial<User>[] {
  return topPlayers.all(limit) as Partial<User>[];
}

export default db;
