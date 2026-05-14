// Lightweight Solana wallet integration
// Supports: Phantom, Solflare, Backpack, any injected provider

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

export type WalletInfo = {
  name: string;
  icon: string;
  installed: boolean;
  provider: any;
  url: string; // install URL
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

// Detect available wallets
export function getAvailableWallets(): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  const w = window as any;

  // Phantom
  const phantom = w.phantom?.solana || (w.solana?.isPhantom ? w.solana : null);
  wallets.push({
    name: 'Phantom',
    icon: '👻',
    installed: !!phantom,
    provider: phantom,
    url: 'https://phantom.app/',
  });

  // Solflare
  const solflare = w.solflare || (w.solana?.isSolflare ? w.solana : null);
  wallets.push({
    name: 'Solflare',
    icon: '🔆',
    installed: !!solflare,
    provider: solflare,
    url: 'https://solflare.com/',
  });

  // Backpack
  const backpack = w.backpack || w.xnft?.solana;
  wallets.push({
    name: 'Backpack',
    icon: '🎒',
    installed: !!backpack,
    provider: backpack,
    url: 'https://backpack.app/',
  });

  return wallets;
}

export async function connectWithProvider(provider: any): Promise<boolean> {
  if (!provider) return false;

  try {
    const resp = await provider.connect();
    const wallet = resp.publicKey.toString();
    state.wallet = wallet;

    // Get nonce from server
    let nonceResp: Response;
    try {
      nonceResp = await fetch(`${SERVER_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
    } catch {
      // Server unreachable — connect without auth (guest mode with wallet)
      state.connected = true;
      state.user = {
        id: '',
        wallet_address: wallet,
        username: 'Player_' + wallet.slice(0, 4),
        avatar_url: null,
        xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
      };
      notify();
      return true;
    }

    if (!nonceResp.ok) {
      // Server error — fallback to guest mode
      state.connected = true;
      state.user = {
        id: '',
        wallet_address: wallet,
        username: 'Player_' + wallet.slice(0, 4),
        avatar_url: null,
        xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
      };
      notify();
      return true;
    }

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

    if (!verifyResp.ok) {
      // Verification failed but wallet is connected
      state.connected = true;
      state.user = {
        id: '',
        wallet_address: wallet,
        username: 'Player_' + wallet.slice(0, 4),
        avatar_url: null,
        xp: 0, level: 1, games_played: 0, games_won: 0, goals_scored: 0,
      };
      notify();
      return true;
    }

    const { token, user } = await verifyResp.json();
    state.connected = true;
    state.token = token;
    state.user = user;
    localStorage.setItem('pb_token', token);
    notify();
    return true;
  } catch (err) {
    console.error('Wallet connect failed:', err);
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
  } catch {
    return false;
  }
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
