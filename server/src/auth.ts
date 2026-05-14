import { PublicKey } from '@solana/web3.js';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import { getOrCreateUser, type User } from './database';

const JWT_SECRET = process.env.JWT_SECRET || 'pumpball-dev-secret-change-in-prod';
const TOKEN_EXPIRY = '7d';

// Active nonces: wallet -> { nonce, createdAt }
const nonces = new Map<string, { nonce: string; createdAt: number }>();

// Clean expired nonces every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of nonces.entries()) {
    if (now - val.createdAt > 5 * 60 * 1000) nonces.delete(key);
  }
}, 5 * 60 * 1000);

export function generateNonce(walletAddress: string): string {
  const nonce = `Sign this message to log in to PumpBall.\n\nWallet: ${walletAddress}\nNonce: ${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  nonces.set(walletAddress, { nonce, createdAt: Date.now() });
  return nonce;
}

export function verifySignature(
  walletAddress: string,
  signature: number[] | Uint8Array,
): User | null {
  const stored = nonces.get(walletAddress);
  if (!stored) return null;

  try {
    const publicKey = new PublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(stored.nonce);
    const signatureBytes = new Uint8Array(signature);

    const verified = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBytes(),
    );

    if (!verified) return null;

    // Clean up nonce
    nonces.delete(walletAddress);

    // Get or create user
    return getOrCreateUser(walletAddress);
  } catch {
    return null;
  }
}

export function createToken(user: User): string {
  return jwt.sign(
    { userId: user.id, wallet: user.wallet_address },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY },
  );
}

export function verifyToken(token: string): { userId: string; wallet: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string; wallet: string };
  } catch {
    return null;
  }
}
