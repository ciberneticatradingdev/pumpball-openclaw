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

export async function verifySignature(
  walletAddress: string,
  signature: number[] | Uint8Array,
): Promise<User | null> {
  const stored = nonces.get(walletAddress);
  if (!stored) return null;

  try {
    // Decode base58 public key manually (32 bytes)
    const pubkeyBytes = decodeBase58(walletAddress);
    const messageBytes = new TextEncoder().encode(stored.nonce);
    const signatureBytes = new Uint8Array(signature);

    const verified = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      pubkeyBytes,
    );

    if (!verified) return null;

    // Clean up nonce
    nonces.delete(walletAddress);

    // Get or create user
    return await getOrCreateUser(walletAddress);
  } catch (e) {
    console.error('Signature verification error:', e);
    return null;
  }
}

// Simple base58 decoder (for Solana public keys)
function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`Invalid base58 char: ${char}`);
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += value;
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = (bytes[j] >> 8);
      bytes[j] &= 0xff;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading zeros
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
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
  } catch { return null; }
}
