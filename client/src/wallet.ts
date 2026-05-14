// PumpBall Wallet — uses Wallet Standard API
// Auto-discovers all installed Solana wallets
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletWithFeatures } from '@wallet-standard/base';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export type UserProfile = {
  id: string;
  wallet_address: string;
  username: string;
  avatar_url: string | null;
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

export async function connectWithWallet(wallet: Wallet): Promise<boolean> {
  try {
    const features = wallet.features as any;

    // Connect
    const connectFeature = features['standard:connect'];
    if (!connectFeature) {
      console.error('Wallet does not support connect');
      return false;
    }

    const connectResult = await connectFeature.connect();
    const account = connectResult.accounts?.[0];
    if (!account) {
      console.error('No account returned');
      return false;
    }

    // Get public key as base58
    const pubkeyBytes = account.publicKey;
    const walletAddress = account.address;

    state.wallet = walletAddress;

    // Try server auth
    try {
      const nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress }),
      });

      if (nonceResp.ok) {
        const { nonce } = await nonceResp.json();

        // Sign message
        const signFeature = features['solana:signMessage'] || features['standard:signMessage'];
        if (signFeature) {
          const messageBytes = new TextEncoder().encode(nonce);
          const signResult = await signFeature.signMessage({
            account,
            message: messageBytes,
          });

          const signature = Array.from(signResult[0]?.signature || signResult?.signature || []);

          // Verify
          const verifyResp = await fetch(`${SERVER_URL}/api/auth/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: walletAddress, signature }),
          });

          if (verifyResp.ok) {
            const { token, user } = await verifyResp.json();
            state.connected = true;
            state.token = token;
            state.user = user;
            localStorage.setItem('pb_token', token);
            notify();
            return true;
          }
        }
      }
    } catch (e) {
      console.warn('Server auth unavailable, using guest mode:', e);
    }

    // Fallback: connected without server auth
    state.connected = true;
    state.user = {
      id: '',
      wallet_address: walletAddress,
      username: 'Player_' + walletAddress.slice(0, 4),
      avatar_url: null,
      xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
    };
    notify();
    return true;
  } catch (err) {
    console.error('Wallet connect error:', err);
    return false;
  }
}

// Legacy fallback for wallets that don't implement wallet-standard
export async function connectLegacy(providerName: string): Promise<boolean> {
  const w = window as any;
  let provider: any = null;

  if (providerName === 'phantom') {
    provider = w.phantom?.solana || (w.solana?.isPhantom ? w.solana : null);
  } else if (providerName === 'solflare') {
    provider = w.solflare;
  } else if (providerName === 'backpack') {
    provider = w.backpack;
  }

  if (!provider) return false;

  try {
    const resp = await provider.connect();
    const walletAddress = resp.publicKey.toString();
    state.wallet = walletAddress;

    // Try server auth
    try {
      const nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: walletAddress }),
      });

      if (nonceResp.ok) {
        const { nonce } = await nonceResp.json();
        const encoded = new TextEncoder().encode(nonce);
        const signed = await provider.signMessage(encoded);
        const signature = Array.from(signed.signature || signed);

        const verifyResp = await fetch(`${SERVER_URL}/api/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: walletAddress, signature }),
        });

        if (verifyResp.ok) {
          const { token, user } = await verifyResp.json();
          state.connected = true;
          state.token = token;
          state.user = user;
          localStorage.setItem('pb_token', token);
          notify();
          return true;
        }
      }
    } catch (e) {
      console.warn('Server auth unavailable:', e);
    }

    // Fallback guest mode
    state.connected = true;
    state.user = {
      id: '',
      wallet_address: walletAddress,
      username: 'Player_' + walletAddress.slice(0, 4),
      avatar_url: null,
      xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
    };
    notify();
    return true;
  } catch (err) {
    console.error('Legacy connect error:', err);
    return false;
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
    const form = new FormData();
    form.append('avatar', file);
    const resp = await fetch(`${SERVER_URL}/api/profile/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: form,
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
