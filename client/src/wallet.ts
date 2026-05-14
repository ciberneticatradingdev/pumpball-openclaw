// PumpBall Wallet — uses Wallet Standard API
// Auto-discovers all installed Solana wallets
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletWithFeatures } from '@wallet-standard/base';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export type UserProfile = {
  id: string;
  wallet_address: string;
  username: string;
  avatar_data: string | null;
  xp: number;
  level: number;
  games_played: number;
  games_won: number;
  goals_scored: number;
};

type AuthState = {
  connected: boolean;
  wallet: string | null;
  token: string | null;
  user: UserProfile | null;
};

export type DetectedWallet = {
  name: string;
  icon: string;
  wallet: Wallet;
};

const state: AuthState = {
  connected: false,
  wallet: null,
  token: localStorage.getItem('pb_token'),
  user: null,
};

type AuthListener = (state: AuthState) => void;
const listeners: AuthListener[] = [];
export function onAuthChange(fn: AuthListener) { listeners.push(fn); }
function notify() { listeners.forEach(fn => fn({ ...state })); }

// Discover all installed Solana wallets via Wallet Standard
export function getDetectedWallets(): DetectedWallet[] {
  const { get } = getWallets();
  const all = get();

  return all
    .filter(w => {
      // Only Solana wallets
      return w.chains?.some((c: string) => c.startsWith('solana:'));
    })
    .map(w => ({
      name: w.name,
      icon: typeof w.icon === 'string' ? w.icon : (w.icon as any)?.[0] || '💰',
      wallet: w,
    }));
}

export type ConnectResult = { success: boolean; isNewUser: boolean };

function looksNewUser(user: UserProfile | null): boolean {
  return !!user && typeof user.username === 'string' && user.username.startsWith('Player_');
}

export async function connectWithWallet(wallet: Wallet): Promise<ConnectResult> {
  try {
    const features = wallet.features as any;

    const connectFeature = features['standard:connect'];
    if (!connectFeature) {
      console.error('[wallet] Wallet does not support standard:connect');
      return { success: false, isNewUser: false };
    }

    console.log('[wallet] Connecting via wallet-standard:', wallet.name);
    const connectResult = await connectFeature.connect();
    const account = connectResult.accounts?.[0];
    if (!account) {
      console.error('[wallet] No account returned from connect');
      return { success: false, isNewUser: false };
    }

    const walletAddress: string = account.address;
    console.log('[wallet] Connected account:', walletAddress);
    state.wallet = walletAddress;

    try {
      const nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress }),
      });

      if (!nonceResp.ok) {
        console.warn('[wallet] /api/auth/nonce failed:', nonceResp.status);
        throw new Error('nonce-fetch-failed');
      }
      const { nonce } = await nonceResp.json();
      console.log('[wallet] Got nonce; requesting signature');

      // Some wallets expose signMessage as an object with .signMessage(),
      // others as a function directly. Standard form: { signMessage(input) }.
      const signFeature = features['solana:signMessage'];
      if (!signFeature?.signMessage) {
        console.error('[wallet] Wallet does not expose solana:signMessage');
        throw new Error('no-signMessage');
      }

      const messageBytes = new TextEncoder().encode(nonce);
      const signResult: any = await signFeature.signMessage({ message: messageBytes, account });
      console.log('[wallet] signMessage result:', signResult);

      // Possible shapes: [{ signature }], { signature }, or Uint8Array
      let signatureBytes: Uint8Array | number[] | null = null;
      if (Array.isArray(signResult) && signResult[0]?.signature) {
        signatureBytes = signResult[0].signature;
      } else if (signResult?.signature) {
        signatureBytes = signResult.signature;
      } else if (signResult instanceof Uint8Array) {
        signatureBytes = signResult;
      }
      if (!signatureBytes) {
        console.error('[wallet] Could not extract signature from result:', signResult);
        throw new Error('bad-signature-shape');
      }

      const signature = Array.from(signatureBytes);

      const verifyResp = await fetch(`${SERVER_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress, signature }),
      });

      if (!verifyResp.ok) {
        console.warn('[wallet] /api/auth/verify failed:', verifyResp.status);
        throw new Error('verify-failed');
      }

      const { token, user } = await verifyResp.json();
      state.connected = true;
      state.token = token;
      state.user = user;
      localStorage.setItem('pb_token', token);
      notify();
      return { success: true, isNewUser: looksNewUser(user) };
    } catch (e) {
      console.warn('[wallet] Server auth unavailable, using guest mode:', e);
    }

    // Fallback: connected without server auth
    state.connected = true;
    state.user = {
      id: '',
      wallet_address: walletAddress,
      username: 'Player_' + walletAddress.slice(0, 4),
      avatar_data: null,
      xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
    };
    notify();
    return { success: true, isNewUser: true };
  } catch (err) {
    console.error('[wallet] connectWithWallet error:', err);
    return { success: false, isNewUser: false };
  }
}

// Legacy fallback for wallets that don't implement wallet-standard
export async function connectLegacy(providerName: string): Promise<ConnectResult> {
  const w = window as any;
  let provider: any = null;

  if (providerName === 'phantom') {
    provider = w.phantom?.solana || (w.solana?.isPhantom ? w.solana : null);
  } else if (providerName === 'solflare') {
    provider = w.solflare;
  } else if (providerName === 'backpack') {
    provider = w.backpack;
  }

  if (!provider) {
    console.error('[wallet] Legacy provider not found:', providerName);
    return { success: false, isNewUser: false };
  }

  try {
    console.log('[wallet] Legacy connect:', providerName);
    const resp = await provider.connect();
    const walletAddress = resp.publicKey.toString();
    console.log('[wallet] Legacy connected:', walletAddress);
    state.wallet = walletAddress;

    try {
      const nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress }),
      });

      if (!nonceResp.ok) {
        console.warn('[wallet] Legacy /api/auth/nonce failed:', nonceResp.status);
        throw new Error('nonce-fetch-failed');
      }
      const { nonce } = await nonceResp.json();
      const encoded = new TextEncoder().encode(nonce);

      // Phantom: signMessage(Uint8Array, 'utf8') -> { signature: Uint8Array, publicKey }
      // Solflare/Backpack: signMessage(Uint8Array) -> Uint8Array (or { signature })
      const signed: any = await provider.signMessage(encoded, 'utf8');
      console.log('[wallet] Legacy sign result:', signed);

      let sigBytes: Uint8Array | number[] | null = null;
      if (signed?.signature) {
        sigBytes = signed.signature;
      } else if (signed instanceof Uint8Array) {
        sigBytes = signed;
      }
      if (!sigBytes) {
        console.error('[wallet] Could not extract signature (legacy):', signed);
        throw new Error('bad-signature-shape');
      }
      const signature = Array.from(sigBytes);

      const verifyResp = await fetch(`${SERVER_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress, signature }),
      });

      if (!verifyResp.ok) {
        console.warn('[wallet] Legacy /api/auth/verify failed:', verifyResp.status);
        throw new Error('verify-failed');
      }

      const { token, user } = await verifyResp.json();
      state.connected = true;
      state.token = token;
      state.user = user;
      localStorage.setItem('pb_token', token);
      notify();
      return { success: true, isNewUser: looksNewUser(user) };
    } catch (e) {
      console.warn('[wallet] Legacy server auth unavailable:', e);
    }

    // Fallback guest mode
    state.connected = true;
    state.user = {
      id: '',
      wallet_address: walletAddress,
      username: 'Player_' + walletAddress.slice(0, 4),
      avatar_data: null,
      xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
    };
    notify();
    return { success: true, isNewUser: true };
  } catch (err) {
    console.error('[wallet] connectLegacy error:', err);
    return { success: false, isNewUser: false };
  }
}

export async function disconnectWallet(): Promise<void> {
  state.connected = false;
  state.wallet = null;
  state.token = null;
  state.user = null;
  localStorage.removeItem('pb_token');
  notify();
}

export async function restoreSession(): Promise<boolean> {
  if (!state.token) return false;
  try {
    const resp = await fetch(`${SERVER_URL}/api/profile`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!resp.ok) {
      localStorage.removeItem('pb_token');
      state.token = null;
      return false;
    }
    const { user } = await resp.json();
    state.connected = true;
    state.user = user;
    state.wallet = user.wallet_address;
    notify();
    return true;
  } catch { return false; }
}

export async function updateProfile(data: { username?: string }): Promise<UserProfile | null> {
  if (!state.token) return null;
  try {
    const resp = await fetch(`${SERVER_URL}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(data),
    });
    if (!resp.ok) return null;
    const { user } = await resp.json();
    state.user = user;
    notify();
    return user;
  } catch { return null; }
}

export async function uploadAvatar(file: File): Promise<UserProfile | null> {
  if (!state.token) return null;
  try {
    // Convert file to base64 data URL
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const resp = await fetch(`${SERVER_URL}/api/profile/avatar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ avatar: dataUrl }),
    });
    if (!resp.ok) return null;
    const { user } = await resp.json();
    state.user = user;
    notify();
    return user;
  } catch { return null; }
}

export function getAuthState(): AuthState { return { ...state }; }

export function getAvatarUrl(avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  if (avatarPath.startsWith('http')) return avatarPath;
  return `${SERVER_URL}${avatarPath}`;
}
