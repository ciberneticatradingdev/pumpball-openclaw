// Lightweight Solana wallet integration — uses Phantom/Solflare's injected provider
// No heavy SDK needed: window.solana / window.phantom.solana

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

const state: AuthState = {
  connected: false,
  wallet: null,
  token: localStorage.getItem('pb_token'),
  user: null,
};

// Listeners
type AuthListener = (state: AuthState) => void;
const listeners: AuthListener[] = [];

export function onAuthChange(fn: AuthListener) { listeners.push(fn); }
function notify() { listeners.forEach(fn => fn({ ...state })); }

function getProvider(): any {
  if ('phantom' in window) {
    const phantom = (window as any).phantom;
    if (phantom?.solana?.isPhantom) return phantom.solana;
  }
  if ('solana' in window) {
    const sol = (window as any).solana;
    if (sol?.isPhantom || sol?.isSolflare) return sol;
  }
  return null;
}

export function isWalletAvailable(): boolean {
  return !!getProvider();
}

export async function connectWallet(): Promise<boolean> {
  const provider = getProvider();
  if (!provider) {
    window.open('https://phantom.app/', '_blank');
    return false;
  }

  try {
    const resp = await provider.connect();
    const wallet = resp.publicKey.toString();
    state.wallet = wallet;

    // Get nonce from server
    const nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet }),
    });

    if (!nonceResp.ok) throw new Error('Failed to get nonce');
    const { nonce } = await nonceResp.json();

    // Sign the nonce
    const encoded = new TextEncoder().encode(nonce);
    const signedMessage = await provider.signMessage(encoded, 'utf8');
    const signature = Array.from(signedMessage.signature);

    // Verify with server
    const verifyResp = await fetch(`${SERVER_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, signature }),
    });

    if (!verifyResp.ok) throw new Error('Verification failed');
    const { token, user } = await verifyResp.json();

    state.connected = true;
    state.token = token;
    state.user = user;
    localStorage.setItem('pb_token', token);

    notify();
    return true;
  } catch (err) {
    console.error('Wallet connect failed:', err);
    state.connected = false;
    return false;
  }
}

export async function disconnectWallet(): Promise<void> {
  const provider = getProvider();
  if (provider) {
    try { await provider.disconnect(); } catch { /* ok */ }
  }
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
  } catch {
    return false;
  }
}

export async function updateProfile(data: { username?: string }): Promise<UserProfile | null> {
  if (!state.token) return null;

  try {
    const resp = await fetch(`${SERVER_URL}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify(data),
    });

    if (!resp.ok) return null;
    const { user } = await resp.json();
    state.user = user;
    notify();
    return user;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }
}

export function getAuthState(): AuthState {
  return { ...state };
}

export function getAvatarUrl(avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  if (avatarPath.startsWith('http')) return avatarPath;
  return `${SERVER_URL}${avatarPath}`;
}
