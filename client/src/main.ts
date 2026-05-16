import './styles.css';
import { io, Socket } from 'socket.io-client';
import { Renderer } from './renderer';
import type { GameState, RoomInfo, ChatMessage, Team, Keyboard, GameMode } from './types';
import { connectWithWallet, connectLegacy, disconnectWallet, restoreSession, updateProfile, uploadAvatar, onAuthChange, getAuthState, getDetectedWallets, type UserProfile } from './wallet';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// Random guest name generator
const ADJECTIVES = ['Fast','Wild','Degen','Based','Pump','Moon','Mega','Ultra','Turbo','Hyper','Giga','Alpha','Sigma','Chad','Anon'];
const NOUNS = ['Kicker','Degen','Ape','Whale','Trader','Pumper','Baller','Sender','Flipper','Runner','Scorer','Striker','Goat','Fren','Anon'];
function randomGuestName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

// ===== DEFAULT AVATARS =====
const DEFAULT_AVATARS = [
  { emoji: '🐸', bg: '#2a6b2a', label: 'Pepe' },
  { emoji: '😈', bg: '#6b2da8', label: 'Trollface' },
  { emoji: '😎', bg: '#9b7a00', label: 'Chad' },
  { emoji: '🦍', bg: '#6b3d2a', label: 'Ape' },
  { emoji: '🐋', bg: '#1a5fa8', label: 'Whale' },
  { emoji: '🚀', bg: '#c85a00', label: 'Rocket' },
  { emoji: '💀', bg: '#222222', label: 'Skull' },
  { emoji: '🤡', bg: '#c4207a', label: 'Clown' },
  { emoji: '👽', bg: '#1a8a1a', label: 'Alien' },
  { emoji: '🔥', bg: '#c82000', label: 'Fire' },
  { emoji: '⭐', bg: '#a89000', label: 'Star' },
  { emoji: '🎮', bg: '#0a7a7a', label: 'Gamer' },
] as const;

let defaultAvatarDataURLs: string[] = [];
let selectedAvatarIndex = -1;

function generateAvatarDataURL(emoji: string, bg: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '72px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 64, 70);
  return canvas.toDataURL('image/png');
}

function generateDefaultAvatars(): void {
  defaultAvatarDataURLs = DEFAULT_AVATARS.map(a => generateAvatarDataURL(a.emoji, a.bg));
  const stored = localStorage.getItem('pumpball_avatar_idx');
  if (stored !== null) {
    const idx = parseInt(stored, 10);
    if (idx >= 0 && idx < defaultAvatarDataURLs.length) selectedAvatarIndex = idx;
  }
}

function getSelectedAvatarDataURL(): string | null {
  if (selectedAvatarIndex >= 0 && selectedAvatarIndex < defaultAvatarDataURLs.length) {
    return defaultAvatarDataURLs[selectedAvatarIndex];
  }
  return null;
}

function compressAvatar(dataUrl: string, maxSize = 128): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d')!;
      // Draw centered/cropped square
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, maxSize, maxSize);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(dataUrl); // fallback to original
    img.src = dataUrl;
  });
}

function getPlayerAvatarData(): string | undefined {
  const auth = getAuthState();
  if (auth.user?.avatar_data) return auth.user.avatar_data;
  return getSelectedAvatarDataURL() || undefined;
}

function renderAvatarPicker(): void {
  const grid = document.getElementById('avatar-grid');
  if (!grid) return;
  grid.innerHTML = '';
  defaultAvatarDataURLs.forEach((dataURL, idx) => {
    const item = document.createElement('div');
    item.className = 'avatar-item' + (idx === selectedAvatarIndex ? ' selected' : '');
    item.title = DEFAULT_AVATARS[idx].label;
    const img = document.createElement('img');
    img.src = dataURL;
    img.alt = DEFAULT_AVATARS[idx].label;
    item.appendChild(img);
    item.addEventListener('click', () => {
      selectedAvatarIndex = idx;
      localStorage.setItem('pumpball_avatar_idx', String(idx));
      grid.querySelectorAll('.avatar-item').forEach((el, i) => {
        el.classList.toggle('selected', i === idx);
      });
    });
    grid.appendChild(item);
  });
}

// ===== STATE =====
let socket: Socket;
let myId = '';
let myName = '';
let guestName = randomGuestName();

function sanitizeName(name: string): string {
  // Strip non-printable and control chars, trim, limit length
  return name.replace(/[^\w\s\-_.!@#$%^&*()]/g, '').trim().slice(0, 20);
}

function validateName(name: string): string | null {
  const clean = sanitizeName(name);
  if (clean.length < 2) return null;
  return clean;
}

function getPlayerName(): string {
  const auth = getAuthState();
  if (auth.user?.username) return auth.user.username;
  if (myName) return myName;
  return guestName;
}
let myTeam: Team = 'spectator';
let currentRoom: RoomInfo | null = null;
let renderer: Renderer | null = null;
let isInGame = false;
let matchesInterval: ReturnType<typeof setInterval> | null = null;
let currentPing = 0;

// Match scorers tracking
type MatchGoal = { scorerName: string; team: Team; minute: number };
let matchGoals: MatchGoal[] = [];
let matchStartTime = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;

// Interpolation state
let prevState: GameState | null = null;
let targetState: GameState | null = null;
let lastStateTime: number = 0;
const SERVER_TICK_MS = 50;

// Keyboard state
const keys: Keyboard = {
  rightClicked: false, leftClicked: false,
  upClicked: false, downClicked: false, spaceClicked: false,
};

// ===== DOM HELPERS =====
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function showScreen(id: 'lobby' | 'room' | 'game') {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`#${id}-screen`).classList.add('active');
}

// ===== TOAST =====
function toast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ===== AUDIO =====
let audioCtx: AudioContext | null = null;
function getAudioCtx() { if (!audioCtx) audioCtx = new AudioContext(); return audioCtx; }

function playSound(freq: number, duration: number, type: OscillatorType = 'sine', vol = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
  } catch { /* noop */ }
}

function playGoalSound() {
  playSound(440, 0.15, 'square', 0.2);
  setTimeout(() => playSound(660, 0.15, 'square', 0.2), 150);
  setTimeout(() => playSound(880, 0.3, 'square', 0.2), 300);
}

function playKickSound() { playSound(200, 0.08, 'sawtooth', 0.1); }

function playCountdownBeep(seconds: number) {
  // Ascending pitch as countdown decreases
  const freq = seconds <= 1 ? 880 : seconds <= 2 ? 660 : seconds <= 3 ? 550 : 440;
  playSound(freq, 0.12, 'sine', 0.18);
}

function playGameStartSound() {
  playSound(523, 0.1, 'square', 0.15);
  setTimeout(() => playSound(659, 0.1, 'square', 0.15), 100);
  setTimeout(() => playSound(784, 0.1, 'square', 0.15), 200);
  setTimeout(() => playSound(1047, 0.25, 'square', 0.2), 300);
}

function playGameOverSound() {
  playSound(784, 0.15, 'sawtooth', 0.15);
  setTimeout(() => playSound(659, 0.15, 'sawtooth', 0.15), 150);
  setTimeout(() => playSound(523, 0.15, 'sawtooth', 0.15), 300);
  setTimeout(() => playSound(392, 0.4, 'sawtooth', 0.12), 450);
}

// ===== CHAT =====
type ChatEntry = { type: 'msg'; msg: ChatMessage; team?: Team } | { type: 'system'; text: string };
const chatHistory: ChatEntry[] = [];

function renderChatEntry(entry: ChatEntry): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  if (entry.type === 'msg') {
    const nameSpan = document.createElement('span');
    nameSpan.className = `msg-name ${entry.team ?? 'spectator'}`;
    nameSpan.textContent = entry.msg.playerName + ':';
    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = ' ' + entry.msg.text;
    div.appendChild(nameSpan); div.appendChild(textSpan);
  } else {
    const span = document.createElement('span');
    span.className = 'msg-name system';
    span.textContent = '⚡ ' + entry.text;
    div.appendChild(span);
  }
  return div;
}

function addChatMessage(container: HTMLElement, msg: ChatMessage, team?: Team) {
  const entry: ChatEntry = { type: 'msg', msg, team };
  chatHistory.push(entry);
  if (chatHistory.length > 200) chatHistory.shift();
  const div = renderChatEntry(entry);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  // Mirror to other chat container
  const otherId = container.id === 'room-chat-messages' ? 'game-chat-messages' : 'room-chat-messages';
  const other = document.getElementById(otherId);
  if (other) { other.appendChild(renderChatEntry(entry)); other.scrollTop = other.scrollHeight; }
}

function addSystemMessage(container: HTMLElement, text: string) {
  const entry: ChatEntry = { type: 'system', text };
  chatHistory.push(entry);
  if (chatHistory.length > 200) chatHistory.shift();
  const div = renderChatEntry(entry);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  const otherId = container.id === 'room-chat-messages' ? 'game-chat-messages' : 'room-chat-messages';
  const other = document.getElementById(otherId);
  if (other) { other.appendChild(renderChatEntry(entry)); other.scrollTop = other.scrollHeight; }
}

function populateChatFromHistory(container: HTMLElement) {
  container.innerHTML = '';
  for (const entry of chatHistory) {
    container.appendChild(renderChatEntry(entry));
  }
  container.scrollTop = container.scrollHeight;
}

// ===== MATCHES POLLING =====
function startMatchesPolling() {
  fetchMatches();
  if (matchesInterval) clearInterval(matchesInterval);
  matchesInterval = setInterval(fetchMatches, 5000);
}

function stopMatchesPolling() {
  if (matchesInterval) { clearInterval(matchesInterval); matchesInterval = null; }
}

function fetchMatches() {
  if (!socket || !socket.connected) return;
  socket.emit('getMatches', (matches: any[]) => {
    renderMatchCards(matches);
    const total = matches.reduce((s: number, m: any) => s + m.players, 0);
    const el = document.getElementById('online-count');
    if (el) el.textContent = String(total);
  });
}


function renderSkeletonCards() {
  const grid = document.getElementById('matches-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.innerHTML = `
      <div class="skeleton-row">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line" style="width:40px"></div>
      </div>
      <div class="skeleton-block"></div>
      <div class="skeleton-row">
        <div class="skeleton-line" style="width:50px"></div>
        <div class="skeleton-line" style="width:50px"></div>
      </div>
    `;
    grid.appendChild(card);
  }
}

function renderMatchCards(matches: any[]) {
  const grid = document.getElementById('matches-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Group by mode
  const modeOrder: GameMode[] = ['1v1', '2v2', '4v4'];
  const grouped: Record<string, any[]> = { '1v1': [], '2v2': [], '4v4': [] };
  for (const m of matches) {
    const mode = m.mode || '4v4';
    if (!grouped[mode]) grouped[mode] = [];
    grouped[mode].push(m);
  }

  for (const mode of modeOrder) {
    const modeMatches = grouped[mode];
    if (!modeMatches || modeMatches.length === 0) continue;

    // Mode group header
    const header = document.createElement('div');
    header.className = 'mode-group-header';
    header.textContent = `${mode}`;
    grid.appendChild(header);

    modeMatches.forEach((m: any, i: number) => {
      const card = document.createElement('div');
      card.className = 'match-card';
      const statusClass = m.status === 'playing' ? 'playing' : 'waiting';
      const statusText = m.status === 'playing' ? '● LIVE' : 'OPEN';
      const maxPlayers = m.maxPlayers || 8;

      card.innerHTML = `
        <div class="match-card-header">
          <span class="match-id">${m.code}</span>
          <span class="match-status ${statusClass}">${statusText}</span>
        </div>
        ${m.status === 'playing' ? `
          <div class="match-score-live">
            <span class="s-red">${m.score.red}</span>
            <span style="color:var(--text-muted)"> — </span>
            <span class="s-blue">${m.score.blue}</span>
          </div>
        ` : ''}
        <div class="match-card-teams">
          <div class="match-team">
            <span class="team-label red">MINT</span>
            <span class="team-count">${m.redPlayers}</span>
          </div>
          <span class="match-vs">VS</span>
          <div class="match-team">
            <span class="team-label blue">WHITE</span>
            <span class="team-count">${m.bluePlayers}</span>
          </div>
        </div>
        <div class="match-card-footer">
          <span>${m.mode || '4v4'} · FREE</span>
          <span>👥 ${m.players}/${maxPlayers}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        const name = getPlayerName();
        myName = name;
        if (m.status === 'playing') {
          toast('Joining as spectator...', 'info');
        } else {
          toast('Joining team...', 'info');
        }
        socket.emit('joinRoom', { roomCode: m.code, name, avatarData: getPlayerAvatarData() }, (success: boolean, error?: string) => {
          if (!success) toast(error || 'Could not join', 'error');
        });
      });

      grid.appendChild(card);
    });
  }
}

// ===== FORMAT TIME =====
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ===== ROOM SCREEN UI =====
function renderRoomInfo(info: RoomInfo) {
  currentRoom = info;
  const mode = info.mode || '4v4';
  const teamSlotCount = mode === '1v1' ? 1 : mode === '2v2' ? 2 : 4;

  $<HTMLElement>('#room-code-value').textContent = info.code;
  const modeBadge = document.getElementById('room-mode-badge');
  if (modeBadge) modeBadge.textContent = mode;

  // Update countdown display from room info (e.g. on rejoin)
  const countdownDisplay = document.getElementById('room-countdown-display');
  const countdownNumber = document.getElementById('room-countdown-number');
  const waitingMsg = document.getElementById('room-waiting-msg');
  if (info.countdown != null) {
    if (countdownDisplay) countdownDisplay.style.display = '';
    if (waitingMsg) waitingMsg.style.display = 'none';
    if (countdownNumber) countdownNumber.textContent = String(info.countdown);
  } else {
    if (countdownDisplay) countdownDisplay.style.display = 'none';
    if (waitingMsg) waitingMsg.style.display = '';
  }

  const redSlots = $<HTMLElement>('#red-slots');
  const blueSlots = $<HTMLElement>('#blue-slots');
  const spectatorList = $<HTMLElement>('#spectator-list');

  const redPlayers = info.players.filter(p => p.team === 'red');
  const bluePlayers = info.players.filter(p => p.team === 'blue');
  const spectators = info.players.filter(p => p.team === 'spectator');

  redSlots.innerHTML = '';
  for (let i = 0; i < teamSlotCount; i++) {
    const slot = document.createElement('div');
    const p = redPlayers[i];
    if (p) {
      slot.className = `team-slot filled red${p.id === myId ? ' me' : ''}`;
      slot.textContent = (p.id === myId ? '▶ ' : '') + p.name;
    } else {
      slot.className = 'team-slot';
      slot.textContent = 'empty slot';
    }
    redSlots.appendChild(slot);
  }

  blueSlots.innerHTML = '';
  for (let i = 0; i < teamSlotCount; i++) {
    const slot = document.createElement('div');
    const p = bluePlayers[i];
    if (p) {
      slot.className = `team-slot filled blue${p.id === myId ? ' me' : ''}`;
      slot.textContent = (p.id === myId ? '▶ ' : '') + p.name;
    } else {
      slot.className = 'team-slot';
      slot.textContent = 'empty slot';
    }
    blueSlots.appendChild(slot);
  }

  // Team ready glow
  const redColumn = redSlots.closest<HTMLElement>('.team-column');
  const blueColumn = blueSlots.closest<HTMLElement>('.team-column');
  if (redColumn) redColumn.classList.toggle('team-ready', redPlayers.length >= teamSlotCount);
  if (blueColumn) blueColumn.classList.toggle('team-ready', bluePlayers.length >= teamSlotCount);

  // Players needed + waiting message with counts
  const totalPlayers = redPlayers.length + bluePlayers.length;
  const totalNeeded = teamSlotCount * 2;
  const stillNeeded = totalNeeded - totalPlayers;
  const neededEl = document.getElementById('room-players-needed');
  if (neededEl) {
    neededEl.textContent = stillNeeded > 0
      ? `${stillNeeded} more player${stillNeeded !== 1 ? 's' : ''} needed`
      : '✓ Teams ready!';
    neededEl.className = `players-needed-msg${stillNeeded === 0 ? ' ready' : ''}`;
  }
  if (waitingMsg && info.countdown == null) {
    waitingMsg.textContent = `Waiting for players... (${totalPlayers}/${totalNeeded})`;
  }

  spectatorList.innerHTML = '';
  spectators.forEach(p => {
    const div = document.createElement('div');
    div.className = 'spectator-item';
    div.textContent = p.name + (p.id === myId ? ' (you)' : '') + (p.id === info.hostId ? ' 👑' : '');
    spectatorList.appendChild(div);
  });

  const myPlayer = info.players.find(p => p.id === myId);
  myTeam = myPlayer?.team ?? 'spectator';
  document.querySelectorAll('.btn-team').forEach(btn => btn.classList.remove('active'));
  const activeBtn = $<HTMLElement>(`.btn-team.${myTeam === 'spectator' ? 'spec' : myTeam}`);
  if (activeBtn) activeBtn.classList.add('active');
}

function renderGamePlayers(state: GameState) {
  const list = $<HTMLElement>('#game-player-list');
  if (!list) return;
  list.innerHTML = '';

  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'game-player-item';

    const dot = document.createElement('div');
    dot.className = `dot ${p.team}`;

    const name = document.createElement('div');
    name.className = 'pname';
    name.textContent = p.name + (p.id === myId ? ' ★' : '');

    const isHost = currentRoom?.hostId === p.id;

    div.appendChild(dot);
    div.appendChild(name);

    if (isHost) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      div.appendChild(badge);
    }

    list.appendChild(div);
  });
}

// ===== KEYBOARD INPUT =====
function setupKeyboard() {
  const keyMap: Record<string, keyof Keyboard> = {
    ArrowRight: 'rightClicked', ArrowLeft: 'leftClicked',
    ArrowUp: 'upClicked', ArrowDown: 'downClicked',
    ' ': 'spaceClicked',
    d: 'rightClicked', a: 'leftClicked', w: 'upClicked', s: 'downClicked',
    x: 'spaceClicked',
  };

  let inputSendTimer: ReturnType<typeof setInterval> | null = null;

  function startInput() {
    if (inputSendTimer) return;
    inputSendTimer = setInterval(() => {
      if (isInGame && myTeam !== 'spectator') {
        socket.emit('playerInput', { ...keys });
      }
    }, 1000 / 30);
  }

  function stopInput() {
    if (inputSendTimer) { clearInterval(inputSendTimer); inputSendTimer = null; }
  }

  document.addEventListener('keydown', (e) => {
    if (!isInGame) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const key = keyMap[e.key];
    if (!key) return;
    e.preventDefault();
    if (!keys[key]) {
      keys[key] = true;
      if (key === 'spaceClicked') playKickSound();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!isInGame) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const key = keyMap[e.key];
    if (!key) return;
    e.preventDefault();
    keys[key] = false;
  });

  document.addEventListener('gameStarted', () => startInput());
  document.addEventListener('gameStopped', () => {
    stopInput();
    Object.keys(keys).forEach(k => { (keys as Record<string, boolean>)[k] = false; });
  });
}

// ===== SOCKET SETUP =====
function setupSocket() {
  socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    myId = socket.id ?? '';
    if (renderer) renderer.setMyId(myId);

    const overlay = document.getElementById('reconnect-overlay');
    const storedToken = sessionStorage.getItem('pumpball_reconnect_token');

    if (storedToken && currentRoom) {
      // Attempt to restore session — overlay stays until 'reconnected' confirms it
      socket.emit('reconnect_attempt', { token: storedToken });
    } else {
      if (overlay) overlay.style.display = 'none';
      toast('Connected', 'success');
    }
  });

  socket.on('disconnect', () => {
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) overlay.style.display = 'flex';
    updatePingDisplay(-1);
  });

  socket.io.on('reconnect_failed', () => {
    sessionStorage.removeItem('pumpball_reconnect_token');
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:700;color:#ff4444;margin-bottom:12px">Connection Lost</div>
          <div style="color:#888;margin-bottom:16px;font-size:13px">Unable to reconnect to server</div>
          <button onclick="location.reload()" style="background:#00ff88;color:#000;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px">RELOAD</button>
        </div>
      `;
    }
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    currentRoom = null;
    showScreen('lobby');
    startMatchesPolling();
  });

  socket.on('reconnectToken', (token: string) => {
    sessionStorage.setItem('pumpball_reconnect_token', token);
  });

  socket.on('reconnected', (info: RoomInfo) => {
    currentRoom = info;
    myId = socket.id ?? '';
    if (renderer) renderer.setMyId(myId);
    const me = info.players.find(p => p.id === myId);
    myTeam = me?.team ?? 'spectator';
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) overlay.style.display = 'none';
    toast('Reconnected!', 'success');
    if (info.status === 'playing') {
      isInGame = true;
      document.dispatchEvent(new Event('gameStarted'));
      if (renderer) { renderer.setFieldConfig(info.mode); renderer.resize(); }
      showScreen('game');
      const codeEl = document.getElementById('topbar-room-code');
      if (codeEl) codeEl.textContent = info.code;
    } else {
      isInGame = false;
      showScreen('room');
      renderRoomInfo(info);
    }
  });

  socket.on('roomJoined', (info: RoomInfo) => {
    currentRoom = info;
    stopMatchesPolling();
    // Set field config based on room mode
    if (renderer && info.mode) {
      renderer.setFieldConfig(info.mode);
    }

    // If game is already playing, go straight to game screen as spectator
    if (info.status === 'playing') {
      isInGame = true;
      prevState = null;
      targetState = null;
      document.dispatchEvent(new Event('gameStarted'));
      showScreen('game');
      if (renderer) renderer.resize();
      const codeEl = document.getElementById('topbar-room-code');
      if (codeEl) codeEl.textContent = info.code;
      chatHistory.length = 0;
      const gameChat = $<HTMLElement>('#game-chat-messages');
      gameChat.innerHTML = '';
      addSystemMessage(gameChat, `Joined room ${info.code} as spectator`);
      toast('Watching match as spectator', 'info');
    } else {
      showScreen('room');
      renderRoomInfo(info);
      chatHistory.length = 0; // Clear history on new room join
      const roomChat = $<HTMLElement>('#room-chat-messages');
      roomChat.innerHTML = '';
      addSystemMessage(roomChat, `Joined room ${info.code} (${info.mode || '4v4'})`);
    }
  });

  // Avatar events — receive once per player, cache in renderer
  socket.on('playerAvatars', (avatars: Array<{ id: string; avatarData: string }>) => {
    if (!renderer) return;
    for (const a of avatars) {
      renderer.setPlayerAvatar(a.id, a.avatarData);
    }
  });

  socket.on('playerAvatar', (data: { id: string; avatarData: string }) => {
    if (!renderer) return;
    renderer.setPlayerAvatar(data.id, data.avatarData);
  });

  socket.on('roomUpdated', (info: RoomInfo) => {
    currentRoom = info;
    const gameScreenActive = document.getElementById('game-screen')?.classList.contains('active');
    if (gameScreenActive && info.status === 'waiting') {
      // Fallback: gameReset was missed but room returned to waiting — force transition
      isInGame = false;
      prevState = null;
      targetState = null;
      document.dispatchEvent(new Event('gameStopped'));
      hideGameOver();
      socket.emit('leaveRoom');
      currentRoom = null;
      showScreen('lobby');
      startMatchesPolling();
      toast('Match ended', 'info');
    } else if (!isInGame) {
      renderRoomInfo(info);
    } else {
      const me = info.players.find(p => p.id === myId);
      if (me) myTeam = me.team;
    }
  });

  socket.on('gameStarted', () => {
    isInGame = true;
    prevState = null;
    targetState = null;
    matchGoals = [];
    matchStartTime = Date.now();
    playGameStartSound();
    document.dispatchEvent(new Event('gameStarted'));
    showScreen('game');

    // Ensure renderer has correct field config for this room's mode
    if (renderer && currentRoom?.mode) {
      renderer.setFieldConfig(currentRoom.mode);
    }
    if (renderer) renderer.resize();

    // Update topbar
    const codeEl = document.getElementById('topbar-room-code');
    if (codeEl) codeEl.textContent = currentRoom?.code ?? '';

    // Show/hide start button
    const startBtn = document.getElementById('game-start-btn');
    if (startBtn) startBtn.style.display = 'none';

    const gameChat = $<HTMLElement>('#game-chat-messages');
    populateChatFromHistory(gameChat);
    addSystemMessage(gameChat, 'Game started! Good luck!');
  });

  let lastPlayerListUpdate = 0;
  socket.on('gameState', (state: GameState) => {
    if (!isInGame) return;

    prevState = targetState;
    targetState = state;
    lastStateTime = performance.now();

    // Update topbar score
    const sr = document.getElementById('topbar-score-red');
    const sb = document.getElementById('topbar-score-blue');
    if (sr) sr.textContent = String(state.score.red);
    if (sb) sb.textContent = String(state.score.blue);

    // Update timer
    const timerEl = document.getElementById('topbar-timer');
    if (timerEl && state.timeLeft !== undefined) {
      timerEl.textContent = formatTime(state.timeLeft);
      if (state.overtime) {
        timerEl.classList.add('overtime');
      } else {
        timerEl.classList.remove('overtime');
      }
    }

    // Player list throttled
    const now = performance.now();
    if (now - lastPlayerListUpdate > 500) {
      renderGamePlayers(state);
      lastPlayerListUpdate = now;
    }
  });

  socket.on('goal', (data: { team: Team; score: { red: number; blue: number }; scorerId?: string; scorerName?: string }) => {
    playGoalSound();
    showGoalOverlay(data.team, data.score, data.scorerName);
    const elapsed = Math.floor((Date.now() - matchStartTime) / 1000);
    const minute = Math.floor(elapsed / 60);
    matchGoals.push({ scorerName: data.scorerName || 'Unknown', team: data.team, minute });
    const sr = document.getElementById('topbar-score-red');
    const sb = document.getElementById('topbar-score-blue');
    if (sr) sr.textContent = String(data.score.red);
    if (sb) sb.textContent = String(data.score.blue);

    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.team === 'red' ? '🟢 MINT' : '⚪ WHITE';
    const scorerText = data.scorerName ? ` (${data.scorerName})` : '';
    addSystemMessage(gameChat, `GOAL! ${teamName}${scorerText} scores! ${data.score.red} - ${data.score.blue}`);
  });

  socket.on('overtime', () => {
    toast('OVERTIME! 1 minute added!', 'info');
    const gameChat = $<HTMLElement>('#game-chat-messages');
    addSystemMessage(gameChat, '⚡ OVERTIME! 1 extra minute!');
  });

  socket.on('playerDisconnected', (data: { name: string }) => {
    const gameChat = $<HTMLElement>('#game-chat-messages');
    addSystemMessage(gameChat, `${data.name} disconnected`);
    toast(`${data.name} left the match`, 'info');
  });

  socket.on('playerJoinedMidGame', (data: { id: string; name: string; team: string }) => {
    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.team === 'red' ? 'MINT' : 'WHITE';
    addSystemMessage(gameChat, `${data.name} joined ${teamName}!`);
    toast(`${data.name} joined ${teamName}`, 'info');
  });

  socket.on('gameOver', (data: { winner: Team | null; score: { red: number; blue: number }; forfeit?: boolean }) => {
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    playGameOverSound();
    showGameOver(data.winner, data.score, data.forfeit);

    const gameChat = $<HTMLElement>('#game-chat-messages');
    if (data.forfeit && data.winner) {
      const teamName = data.winner === 'red' ? 'MINT' : 'WHITE';
      addSystemMessage(gameChat, `GAME OVER! ${teamName} WINS BY FORFEIT!`);
      toast(`${teamName} wins by forfeit!`, 'info');
    } else {
      const teamName = data.winner ? (data.winner === 'red' ? 'MINT' : 'WHITE') : 'DRAW';
      addSystemMessage(gameChat, `GAME OVER! ${teamName}${data.winner ? ' WINS!' : '!'} Final: ${data.score.red} - ${data.score.blue}`);
    }
    // gameReset event will handle transition back to room screen after server's 4s delay
  });

  socket.on('gameReset', () => {
    isInGame = false;
    prevState = null;
    targetState = null;
    matchGoals = [];
    document.dispatchEvent(new Event('gameStopped'));
    hideGameOver();
    // Stay in room for rematch — go to room screen, not lobby
    if (currentRoom) {
      showScreen('room');
      toast('Match ended — waiting for next game', 'info');
    } else {
      showScreen('lobby');
      startMatchesPolling();
      toast('Match ended', 'info');
    }
  });

  socket.on('countdown', (data: { seconds: number }) => {
    const countdownDisplay = document.getElementById('room-countdown-display');
    const countdownNumber = document.getElementById('room-countdown-number');
    const waitingMsg = document.getElementById('room-waiting-msg');
    if (countdownDisplay) countdownDisplay.style.display = '';
    if (waitingMsg) waitingMsg.style.display = 'none';
    if (countdownNumber) countdownNumber.textContent = String(data.seconds);
    playCountdownBeep(data.seconds);
    if (data.seconds === 5) toast('Game starting in 5...', 'info');
  });

  socket.on('countdownCancelled', () => {
    const countdownDisplay = document.getElementById('room-countdown-display');
    const waitingMsg = document.getElementById('room-waiting-msg');
    if (countdownDisplay) countdownDisplay.style.display = 'none';
    if (waitingMsg) waitingMsg.style.display = '';
    toast('Countdown cancelled - waiting for players', 'info');
  });

  socket.on('chatMessage', (msg: ChatMessage) => {
    const senderTeam = currentRoom?.players.find(p => p.name === msg.playerName)?.team;
    // Use the currently visible chat container — unified chat mirrors to both
    const activeContainer = isInGame
      ? document.getElementById('game-chat-messages')
      : document.getElementById('room-chat-messages');
    if (activeContainer) addChatMessage(activeContainer, msg, senderTeam);
  });

  socket.on('error', (message: string) => { toast(message, 'error'); });

  // Ping measurement
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    const start = Date.now();
    socket.emit('ping', () => {
      currentPing = Date.now() - start;
      updatePingDisplay();
    });
  }, 3000);
}

// ===== OVERLAYS =====
function showGoalOverlay(team: Team, score: { red: number; blue: number }, scorerName?: string) {
  const overlay = $<HTMLElement>('#goal-overlay');
  const text = $<HTMLElement>('#goal-text');
  const sub = $<HTMLElement>('#goal-sub');
  text.className = `goal-text ${team}`;
  text.textContent = 'GOAL!';
  sub.textContent = scorerName ? `${score.red} — ${score.blue} · ${scorerName}` : `${score.red} — ${score.blue}`;
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 1500);
}

function showGameOver(winner: Team | null, score: { red: number; blue: number }, forfeit?: boolean) {
  const overlay = $<HTMLElement>('#gameover-overlay');
  const resultEl = document.getElementById('gameover-result');
  const text = $<HTMLElement>('#winner-text');
  const finalScore = $<HTMLElement>('#gameover-score');
  const countdownEl = document.getElementById('gameover-countdown');
  const scorersEl = document.getElementById('gameover-scorers');
  const actionsEl = document.getElementById('gameover-actions');
  const rematchBtn = document.getElementById('gameover-rematch-btn');
  const leaveBtn = document.getElementById('gameover-leave-btn');

  let resultText: string;
  let resultClass: string;
  if (!winner) {
    resultText = 'DRAW';
    resultClass = 'draw';
  } else if (myTeam === 'spectator') {
    resultText = winner === 'red' ? 'MINT WINS' : 'WHITE WINS';
    resultClass = 'spectator';
  } else if (winner === myTeam) {
    resultText = 'VICTORY';
    resultClass = 'victory';
  } else {
    resultText = 'DEFEAT';
    resultClass = 'defeat';
  }

  if (resultEl) {
    resultEl.textContent = resultText;
    resultEl.className = `gameover-result ${resultClass}`;
  }

  text.className = `winner-text ${winner || 'draw'}`;
  if (winner) {
    const teamName = winner === 'red' ? 'MINT' : 'WHITE';
    text.textContent = forfeit ? `${teamName} WINS BY FORFEIT` : `${teamName} WINS`;
  } else {
    text.textContent = 'DRAW';
  }

  finalScore.textContent = `MINT ${score.red}  \u2014  ${score.blue} WHITE`;

  // Render goal scorers
  if (scorersEl) {
    if (matchGoals.length > 0) {
      scorersEl.innerHTML = matchGoals.map(g => {
        const icon = g.team === 'red' ? '\u{1F7E2}' : '\u26AA';
        return `<div class="scorer-entry"><span class="scorer-icon">${icon}</span><span class="scorer-name">${g.scorerName}</span><span class="scorer-time">${g.minute}'</span></div>`;
      }).join('');
    } else {
      scorersEl.innerHTML = '';
    }
  }

  // Show actions
  const isPersistent = currentRoom?.code?.startsWith('PUMP-');
  if (actionsEl) actionsEl.style.display = '';
  if (rematchBtn) {
    // Rematch = stay in room for next game
    rematchBtn.style.display = '';
    rematchBtn.textContent = isPersistent ? '\u26A1 NEXT GAME' : '\u26A1 REMATCH';
    rematchBtn.onclick = () => {
      hideGameOver();
      showScreen('room');
    };
  }
  if (leaveBtn) {
    leaveBtn.onclick = () => {
      hideGameOver();
      socket.emit('leaveRoom');
      currentRoom = null;
      isInGame = false;
      document.dispatchEvent(new Event('gameStopped'));
      showScreen('lobby');
      startMatchesPolling();
      toast('Left match', 'info');
    };
  }

  overlay.style.display = '';  // reset inline override from hideGameOver
  overlay.classList.add('show');

  // Countdown — just visual, doesn't force transition
  let secs = 5;
  if (countdownEl) countdownEl.textContent = `Auto-return to room in ${secs}...`;
  if (gameOverCountdownInterval) clearInterval(gameOverCountdownInterval);
  gameOverCountdownInterval = setInterval(() => {
    secs--;
    if (countdownEl) {
      countdownEl.textContent = secs > 0 ? `Auto-return to room in ${secs}...` : '';
    }
    if (secs <= 0) { clearInterval(gameOverCountdownInterval!); gameOverCountdownInterval = null; }
  }, 1000);
}

let gameOverCountdownInterval: ReturnType<typeof setInterval> | null = null;
function hideGameOver() {
  if (gameOverCountdownInterval) { clearInterval(gameOverCountdownInterval); gameOverCountdownInterval = null; }
  const overlay = $<HTMLElement>('#gameover-overlay');
  overlay.classList.remove('show');
  overlay.style.display = 'none';
}

function updatePingDisplay(ping?: number) {
  const el = document.getElementById('ping-display');
  if (!el) return;
  if (ping === -1) {
    el.textContent = 'Offline';
    el.style.color = '#ff4444';
    return;
  }
  const p = ping !== undefined ? ping : currentPing;
  el.textContent = p + 'ms';
  el.style.color = p < 80 ? '#00ff88' : p < 150 ? '#ffcc00' : '#ff4444';
}

// ===== LEADERBOARD =====
function showLeaderboard() {
  const section = document.getElementById('leaderboard-section');
  if (!section) return;
  section.classList.add('active');
  section.innerHTML = '<div style="text-align:center;padding:24px;color:#888">Loading...</div>';
  fetch(`${SERVER_URL}/api/leaderboard`).then(r => r.json()).then(data => {
    const players = data.players || [];
    if (players.length === 0) {
      section.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#888"><div style="font-size:32px;margin-bottom:12px">🏆</div><div style="font-size:14px">No players yet. Be the first!</div></div>';
      return;
    }
    let html = '<div class="section-heading"><h2>🏆 Leaderboard</h2><span class="heading-sub">Top players by wins</span></div>';
    html += '<div class="leaderboard-list">';
    players.forEach((p: any, i: number) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      const name = p.username || p.wallet_address?.slice(0, 8) + '...' || 'Anonymous';
      html += `<div class="leaderboard-row${i < 3 ? ' top-three' : ''}">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${name}</span>
        <span class="lb-stat">${p.games_won ?? 0}W</span>
        <span class="lb-stat">${p.goals_scored ?? 0}G</span>
        <span class="lb-stat">${p.games_played ?? 0}P</span>
      </div>`;
    });
    html += '</div>';
    section.innerHTML = html;
  }).catch(() => {
    section.innerHTML = '<div style="text-align:center;padding:40px;color:#ff4444">Failed to load leaderboard</div>';
  });
}

function hideLeaderboard() {
  const section = document.getElementById('leaderboard-section');
  if (section) section.classList.remove('active');
}

// ===== SIDEBAR HTML (shared) =====
function sidebarHTML(context: 'lobby' | 'game') {
  const cls = context === 'game' ? 'game-left-sidebar' : 'sidebar';
  return `
    <div class="${cls}">
      <div class="sidebar-logo">
        <img src="/logo-full.png" alt="PumpBall" class="sidebar-logo-img" />
      </div>
      <div class="sidebar-nav">
        <button class="nav-item active" data-nav="play"><span class="nav-icon">▶</span> Play</button>
        <button class="nav-item" data-nav="profile"><span class="nav-icon">👤</span> Profile</button>
        <button class="nav-item" data-nav="leaderboard"><span class="nav-icon">🏆</span> Leaderboard</button>
        <button class="nav-item" data-nav="settings"><span class="nav-icon">⚙</span> Settings</button>
        <button class="nav-item" data-nav="about"><span class="nav-icon">ℹ️</span> About</button>
      </div>
      <div class="sidebar-user">
        <div class="user-info">
          <div class="user-avatar">💊</div>
          <div class="user-details">
            <div class="user-name" id="${context}-username">Guest</div>
            <div class="user-handle">@anonymous</div>
          </div>
        </div>
        <div class="user-level">
          <span class="lvl-badge">LVL 1</span>
          <div class="xp-bar"><div class="xp-fill"></div></div>
        </div>
        <button id="${context === 'lobby' ? 'connect-wallet-btn' : 'game-wallet-btn'}" class="wallet-btn">🔗 Connect Wallet</button>
      </div>
      <div class="sidebar-socials">
        <a class="social-link" title="X/Twitter">𝕏</a>
        <a class="social-link" title="Discord">💬</a>
        <a class="social-link" title="Telegram">✈</a>
      </div>
    </div>
  `;
}

// ===== HTML TEMPLATE =====
function buildUI() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <!-- LOBBY SCREEN -->
    <div id="lobby-screen" class="screen active">
      ${sidebarHTML('lobby')}
      <main class="lobby-main">
        <div class="lobby-header">
          <div class="online-badge">
            <span class="status-dot"></span>
            <span id="online-count">0</span> online
          </div>
        </div>

        <section class="matches-section">
          <div class="section-heading">
            <h2>Live Matches</h2>
            <span class="heading-sub">1v1 · 2v2 · 4v4 · Free to play</span>
          </div>
          <div id="matches-grid" class="matches-grid"></div>
        </section>

        <!-- Avatar Picker Section -->
        <section class="avatar-picker-section" id="avatar-picker-section">
          <div class="section-heading">
            <h2>Choose Avatar</h2>
            <span class="heading-sub">Pick your meme character</span>
          </div>
          <div id="avatar-grid" class="avatar-grid"></div>
        </section>

        <section class="custom-section">
          <div class="custom-info">
            <h3><span class="lock-icon">🔒</span> Custom Match</h3>
            <p>Create a private lobby. Wager mode coming soon.</p>
          </div>
          <div class="custom-actions">
            <div class="join-by-code">
              <input type="text" id="join-code-input" placeholder="CODE" maxlength="8" />
              <button id="join-room-btn" class="btn btn-secondary btn-sm">Join</button>
            </div>
            <button id="create-room-btn" class="btn-outlined">Create Custom Match</button>
          </div>
        </section>

        <div id="lobby-error" class="error-msg"></div>

          <!-- Leaderboard Section (hidden by default) -->
          <div id="leaderboard-section" class="leaderboard-screen"></div>

          <!-- Profile Section (hidden by default, shown via nav) -->
          <div id="profile-section" class="profile-screen">
            <div id="profile-connected" style="display:none">
              <div class="profile-header">
                <div class="profile-avatar-wrapper" id="avatar-wrapper">
                  <div class="profile-avatar" id="profile-avatar">💊</div>
                  <div class="profile-avatar-overlay">📷</div>
                  <input type="file" id="avatar-input" accept="image/*" style="display:none" />
                </div>
                <div class="profile-info">
                  <h2 id="profile-display-name">Player</h2>
                  <div class="wallet-address" id="profile-wallet" title="Click to copy">---</div>
                </div>
              </div>
              <div class="profile-stats">
                <div class="stat-card"><div class="stat-value" id="stat-games">0</div><div class="stat-label">Games</div></div>
                <div class="stat-card"><div class="stat-value" id="stat-wins">0</div><div class="stat-label">Wins</div></div>
                <div class="stat-card"><div class="stat-value" id="stat-goals">0</div><div class="stat-label">Goals</div></div>
                <div class="stat-card"><div class="stat-value" id="stat-level">1</div><div class="stat-label">Level</div></div>
              </div>
              <div class="profile-form">
                <label>USERNAME</label>
                <div style="display:flex;gap:8px">
                  <input type="text" id="profile-username-input" placeholder="Your name..." maxlength="20" />
                  <button id="save-username-btn" class="btn btn-primary btn-sm">Save</button>
                </div>
              </div>
              <button id="disconnect-wallet-btn" class="btn btn-danger btn-sm" style="margin-top:12px;max-width:200px">Disconnect Wallet</button>
            </div>
            <div id="profile-not-connected" class="not-connected-msg">
              <span class="big-icon">🔗</span>
              Connect your wallet to create a profile, track stats, and customize your player.
              <br/><br/>
              <button id="profile-connect-btn" class="btn btn-primary">Connect Wallet</button>
            </div>
          </div>
      </main>
    </div>

    <!-- ROOM SCREEN -->
    <div id="room-screen" class="screen">
      <div class="room-layout">
        <div class="room-sidebar">
          <div class="room-header">
            <div id="room-mode-badge" class="room-mode-badge">4v4</div>
            <div class="room-code-display">
              <span class="label">Room</span>
              <span id="room-code-value" class="room-code" title="Click to copy">------</span>
            </div>
            <div class="room-code-hint">Share this code with friends</div>
          </div>
          <div class="room-main">
            <div>
              <div class="section-label">Teams</div>
              <div class="teams-grid">
                <div class="team-column">
                  <div class="team-title red">MINT</div>
                  <div id="red-slots"></div>
                </div>
                <div class="team-column">
                  <div class="team-title blue">WHITE</div>
                  <div id="blue-slots"></div>
                </div>
              </div>
              <div id="room-players-needed" class="players-needed-msg"></div>
            </div>
            <div class="spectators-section">
              <div class="section-label">Spectators</div>
              <div id="spectator-list"></div>
            </div>
            <div>
              <div class="section-label">Join team</div>
              <div class="team-buttons">
                <button class="btn-team red" data-team="red">Mint</button>
                <button class="btn-team blue" data-team="blue">White</button>
                <button class="btn-team spec" data-team="spectator">Spec</button>
              </div>
            </div>
          </div>
          <div class="room-footer">
            <div id="room-countdown-display" style="display:none; text-align:center; margin-bottom:8px">
              <div id="room-countdown-number" style="font-size:56px; font-weight:900; line-height:1; color:var(--accent, #00ff88); text-shadow:0 0 20px var(--accent, #00ff88)">5</div>
              <div style="font-size:11px; letter-spacing:2px; color:var(--text-muted, #888); margin-top:4px">GAME STARTING</div>
            </div>
            <div id="room-waiting-msg" style="text-align:center; font-size:12px; color:var(--text-muted, #888); margin-bottom:8px">Waiting for players...</div>
            <button id="leave-room-btn" class="btn btn-danger btn-sm">Leave Room</button>
          </div>
        </div>
        <div class="chat-panel">
          <div class="chat-header"><span class="status-dot"></span>Room Chat</div>
          <div id="room-chat-messages" class="chat-messages"></div>
          <div class="chat-input-row">
            <input type="text" id="room-chat-input" placeholder="Type a message..." maxlength="200" />
            <button id="room-chat-send" class="btn btn-secondary btn-sm">Send</button>
          </div>
        </div>
      </div>
    </div>

    <!-- GAME SCREEN -->
    <div id="game-screen" class="screen">
      <!-- Top Bar -->
      <div class="game-topbar">
        <div class="topbar-left">
          <span class="topbar-logo"><img src="/logo.png" alt="PumpBall" class="topbar-logo-img" /> PUMPBALL</span>
        </div>
        <div class="topbar-center">
          <div class="topbar-score">
            <span class="t-red" id="topbar-score-red">0</span>
            <span class="t-vs">VS</span>
            <span class="t-blue" id="topbar-score-blue">0</span>
          </div>
          <div class="topbar-timer" id="topbar-timer">05:00</div>
          <div class="topbar-info">FIRST TO 5 WINS</div>
        </div>
        <div class="topbar-right">
          <span id="ping-display" style="font-size:11px;font-family:monospace;color:#00ff88;margin-right:6px"></span>
          <span class="topbar-room" id="topbar-room-code" title="Click to copy">------</span>
          <button class="btn-leave" id="game-leave-btn">LEAVE</button>
        </div>
      </div>

      <!-- Body: sidebar + canvas + right sidebar -->
      <div class="game-body">
        ${sidebarHTML('game')}

        <div class="game-center">
          <div class="canvas-container">
            <canvas id="game-canvas"></canvas>
          </div>
        </div>

        <div class="game-right-sidebar">
          <div class="game-players-panel">
            <div class="panel-header">PLAYERS</div>
            <div id="game-player-list" class="game-player-list"></div>
          </div>

          <div class="game-chat-wrapper">
            <div class="panel-header"><span class="status-dot"></span>CHAT</div>
            <div id="game-chat-messages" class="chat-messages"></div>
            <div class="chat-input-row">
              <input type="text" id="game-chat-input" placeholder="Type..." maxlength="200" />
              <button id="game-chat-send" class="btn btn-secondary btn-sm">↵</button>
            </div>
          </div>

          <div class="controls-panel">
            <div class="panel-header">CONTROLS</div>
            <div class="controls-grid">
              <div class="control-row">
                <span class="label">Move</span>
                <div class="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></div>
              </div>
              <div class="control-row">
                <span class="label">Kick</span>
                <div class="key-group"><kbd>SPACE</kbd></div>
              </div>
              <div class="control-row">
                <span class="label">Power</span>
                <div class="key-group"><kbd>X</kbd></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Bar -->
      <div class="game-bottombar">
        <div class="bottombar-left">PUMP TO WIN · FAST · FUN · MEME</div>
        <div class="bottombar-center">
          <button class="btn-start-match" id="game-start-btn" style="display:none">▶ START MATCH</button>
        </div>
        <div class="bottombar-right">
          <button class="bar-icon" title="Sound">🔊</button>
          <button class="bar-icon" title="Music">🎵</button>
          <button class="bar-icon" id="fullscreen-btn" title="Fullscreen">⛶</button>
        </div>
      </div>
    </div>

    <!-- Overlays -->
    <div id="goal-overlay" class="goal-overlay">
      <div class="goal-banner">
        <div id="goal-text" class="goal-text red">GOAL!</div>
        <div id="goal-sub" class="goal-sub">0 — 0</div>
      </div>
    </div>

    <div id="gameover-overlay" class="gameover-overlay">
      <div class="gameover-banner">
        <div id="gameover-result" class="gameover-result victory">VICTORY</div>
        <div id="winner-text" class="winner-text red">MINT WINS</div>
        <div id="gameover-score" class="final-score">5 — 0</div>
        <div id="gameover-scorers" class="gameover-scorers"></div>
        <div id="gameover-actions" class="gameover-actions">
          <button id="gameover-rematch-btn" class="btn btn-primary gameover-btn">⚡ REMATCH</button>
          <button id="gameover-leave-btn" class="btn btn-danger gameover-btn">LEAVE</button>
        </div>
        <div id="gameover-countdown" class="gameover-sub">Returning to room in 5...</div>
      </div>
    </div>

    <!-- Welcome / Onboarding Modal -->
    <div id="welcome-modal" class="welcome-modal-overlay">
      <div class="welcome-modal">
        <div class="welcome-header">
          <div class="welcome-title">💊 WELCOME TO PUMPBALL</div>
          <div class="welcome-sub">Set up your player profile</div>
        </div>
        <div class="welcome-avatar-section">
          <div class="welcome-avatar-wrapper" id="welcome-avatar-wrapper">
            <div class="welcome-avatar" id="welcome-avatar">💊</div>
            <div class="welcome-avatar-overlay">📷</div>
            <input type="file" id="welcome-avatar-input" accept="image/*" style="display:none" />
          </div>
          <div class="welcome-avatar-label">Click to upload your photo</div>
        </div>
        <div class="welcome-form">
          <label>USERNAME</label>
          <input type="text" id="welcome-username-input" maxlength="20" />
        </div>
        <div class="welcome-wallet">Your wallet: <span id="welcome-wallet-addr">---</span></div>
        <button id="welcome-play-btn" class="btn btn-primary welcome-play-btn">LET'S PLAY</button>
        <button id="welcome-skip-btn" class="welcome-skip-btn">Skip for now</button>
      </div>
    </div>

    <!-- Wallet Selector Modal -->
    <div id="wallet-modal" class="wallet-modal-overlay">
      <div class="wallet-modal">
        <h3>CONNECT WALLET</h3>
        <p class="modal-sub">Choose your Solana wallet</p>
        <div id="wallet-list" class="wallet-list"></div>
        <button class="wallet-modal-close" id="wallet-modal-close">Cancel</button>
      </div>
    </div>

    <div id="toast-container" class="toast-container"></div>

    <div id="reconnect-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;align-items:center;justify-content:center;flex-direction:column;gap:16px">
      <div class="reconnect-spinner"></div>
      <div style="color:#00ff88;font-size:16px;font-weight:700;letter-spacing:3px">RECONNECTING...</div>
    </div>
  `;
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Lobby — Create custom room
  $<HTMLButtonElement>('#create-room-btn').addEventListener('click', () => {
    const name = getPlayerName();
    myName = name;
    $<HTMLElement>('#lobby-error').textContent = '';
    socket.emit('createRoom', name, (roomCode: string) => {
      toast(`Room ${roomCode} created!`, 'success');
      stopMatchesPolling();
      showScreen('room');
      currentRoom = {
        code: roomCode,
        players: [{ id: myId, name, team: 'spectator' }],
        hostId: myId,
        status: 'waiting',
        score: { red: 0, blue: 0 },
      };
      renderRoomInfo(currentRoom);
      const roomChat = $<HTMLElement>('#room-chat-messages');
      roomChat.innerHTML = '';
      addSystemMessage(roomChat, `Room ${roomCode} created!`);
    });
  });

  // Lobby — Join by code
  function joinRoom() {
    const name = getPlayerName();
    const code = $<HTMLInputElement>('#join-code-input').value.trim().toUpperCase();
    const errEl = $<HTMLElement>('#lobby-error');
    if (!code) { errEl.textContent = 'Enter a room code'; return; }
    myName = name;
    errEl.textContent = '';
    socket.emit('joinRoom', { roomCode: code, name, avatarData: getPlayerAvatarData() }, (success: boolean, error?: string) => {
      if (!success) { errEl.textContent = error ?? 'Could not join'; toast(error ?? 'Could not join', 'error'); }
    });
  }

  $<HTMLButtonElement>('#join-room-btn').addEventListener('click', joinRoom);
  $<HTMLInputElement>('#join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

  // === Welcome / Onboarding Modal (first-time wallet connect) ===
  let welcomePendingFile: File | null = null;
  let welcomePendingDataUrl: string | null = null;

  function showWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    if (!modal) return;
    const auth = getAuthState();
    welcomePendingFile = null;
    welcomePendingDataUrl = null;

    const usernameInput = document.getElementById('welcome-username-input') as HTMLInputElement | null;
    if (usernameInput) usernameInput.value = auth.user?.username || '';

    const walletAddrEl = document.getElementById('welcome-wallet-addr');
    if (walletAddrEl && auth.wallet) {
      walletAddrEl.textContent = auth.wallet.slice(0, 4) + '...' + auth.wallet.slice(-4);
    }

    const avatarEl = document.getElementById('welcome-avatar');
    if (avatarEl) {
      if (auth.user?.avatar_data) {
        avatarEl.innerHTML = '<img src="' + auth.user.avatar_data + '" />';
      } else {
        avatarEl.textContent = '💊';
      }
    }

    const fileInput = document.getElementById('welcome-avatar-input') as HTMLInputElement | null;
    if (fileInput) fileInput.value = '';

    modal.classList.add('show');
  }

  function hideWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    if (modal) modal.classList.remove('show');
    welcomePendingFile = null;
    welcomePendingDataUrl = null;
  }

  const welcomeAvatarWrapper = document.getElementById('welcome-avatar-wrapper');
  const welcomeAvatarInput = document.getElementById('welcome-avatar-input') as HTMLInputElement | null;
  const welcomeAvatar = document.getElementById('welcome-avatar');
  if (welcomeAvatarWrapper && welcomeAvatarInput) {
    welcomeAvatarWrapper.addEventListener('click', () => welcomeAvatarInput.click());
    welcomeAvatarInput.addEventListener('change', () => {
      const file = welcomeAvatarInput.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Max 2MB', 'error'); return; }
      welcomePendingFile = file;
      const reader = new FileReader();
      reader.onload = async () => {
        const compressed = await compressAvatar(reader.result as string);
        welcomePendingDataUrl = compressed;
        if (welcomeAvatar) welcomeAvatar.innerHTML = '<img src="' + compressed + '" />';
      };
      reader.readAsDataURL(file);
    });
  }

  const welcomePlayBtn = document.getElementById('welcome-play-btn');
  if (welcomePlayBtn) {
    welcomePlayBtn.addEventListener('click', async () => {
      const input = document.getElementById('welcome-username-input') as HTMLInputElement | null;
      const username = input?.value.trim() || '';
      welcomePlayBtn.setAttribute('disabled', 'true');
      try {
        if (username) {
          const u = await updateProfile({ username });
          if (u) {
            myName = u.username;
            
          }
        }
        if (welcomePendingFile) {
          const u = await uploadAvatar(welcomePendingFile);
          if (!u) toast('Avatar upload failed', 'error');
        }
        toast('Profile ready!', 'success');
      } finally {
        welcomePlayBtn.removeAttribute('disabled');
        hideWelcomeModal();
      }
    });
  }

  const welcomeSkipBtn = document.getElementById('welcome-skip-btn');
  if (welcomeSkipBtn) welcomeSkipBtn.addEventListener('click', () => hideWelcomeModal());

  const welcomeModalEl = document.getElementById('welcome-modal');
  if (welcomeModalEl) welcomeModalEl.addEventListener('click', (e) => {
    if (e.target === welcomeModalEl) hideWelcomeModal();
  });

  // === Wallet Connect (with selector modal) ===
  function showWalletModal() {
    const modal = document.getElementById('wallet-modal')!;
    const list = document.getElementById('wallet-list')!;

    // Get wallets from Wallet Standard
    const detected = getDetectedWallets();

    // Also check legacy providers
    const w = window as any;
    const legacyWallets: { name: string; icon: string; key: string; installed: boolean; url: string }[] = [
      { name: 'Phantom', icon: '👻', key: 'phantom', installed: !!(w.phantom?.solana || w.solana?.isPhantom), url: 'https://phantom.app/' },
      { name: 'Solflare', icon: '🔆', key: 'solflare', installed: !!w.solflare, url: 'https://solflare.com/' },
      { name: 'Backpack', icon: '🎒', key: 'backpack', installed: !!w.backpack, url: 'https://backpack.app/' },
    ];

    list.innerHTML = '';

    // Show Wallet Standard detected wallets first
    const shownNames = new Set<string>();
    detected.forEach(dw => {
      shownNames.add(dw.name.toLowerCase());
      const btn = document.createElement('button');
      btn.className = 'wallet-option';

      const iconEl = document.createElement('div');
      iconEl.className = 'wallet-icon';
      // Use wallet icon (could be data URL)
      if (dw.icon.startsWith('data:') || dw.icon.startsWith('http')) {
        iconEl.innerHTML = '<img src="' + dw.icon + '" style="width:24px;height:24px;border-radius:4px" />';
      } else {
        iconEl.textContent = dw.icon;
      }

      btn.appendChild(iconEl);

      const nameEl = document.createElement('span');
      nameEl.className = 'wallet-name';
      nameEl.textContent = dw.name;
      btn.appendChild(nameEl);

      const tagEl = document.createElement('span');
      tagEl.className = 'wallet-tag';
      tagEl.textContent = 'DETECTED';
      btn.appendChild(tagEl);

      btn.addEventListener('click', async () => {
        modal.classList.remove('show');
        toast('Connecting to ' + dw.name + '...', 'info');
        const result = await connectWithWallet(dw.wallet);
        if (result.success) {
          toast('Connected to ' + dw.name + '!', 'success');
          const auth = getAuthState();
          if (auth.user) {
            
            myName = auth.user.username;
          }
          if (result.isNewUser) showWelcomeModal();
        } else {
          toast('Connection rejected or failed', 'error');
        }
      });

      list.appendChild(btn);
    });

    // Show legacy wallets that weren't in wallet-standard
    legacyWallets.forEach(lw => {
      if (shownNames.has(lw.name.toLowerCase())) return;

      const btn = document.createElement('button');
      btn.className = 'wallet-option' + (lw.installed ? '' : ' not-installed');
      btn.innerHTML = '<div class="wallet-icon">' + lw.icon + '</div>'
        + '<span class="wallet-name">' + lw.name + '</span>'
        + '<span class="wallet-tag">' + (lw.installed ? 'DETECTED' : 'INSTALL') + '</span>';

      btn.addEventListener('click', async () => {
        if (!lw.installed) {
          window.open(lw.url, '_blank');
          return;
        }
        modal.classList.remove('show');
        toast('Connecting to ' + lw.name + '...', 'info');
        const result = await connectLegacy(lw.key);
        if (result.success) {
          toast('Connected to ' + lw.name + '!', 'success');
          const auth = getAuthState();
          if (auth.user) {
            
            myName = auth.user.username;
          }
          if (result.isNewUser) showWelcomeModal();
        } else {
          toast('Connection rejected or failed', 'error');
        }
      });

      list.appendChild(btn);
    });

    // If nothing detected at all
    if (list.children.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:12px">No wallets detected.<br>Install <a href="https://phantom.app" target="_blank" style="color:var(--accent)">Phantom</a> or <a href="https://solflare.com" target="_blank" style="color:var(--accent)">Solflare</a></div>';
    }

    modal.classList.add('show');
  }

  // Close modal
  const walletModalClose = document.getElementById('wallet-modal-close');
  if (walletModalClose) walletModalClose.addEventListener('click', () => {
    document.getElementById('wallet-modal')!.classList.remove('show');
  });
  // Close on overlay click
  const walletModal = document.getElementById('wallet-modal');
  if (walletModal) walletModal.addEventListener('click', (e) => {
    if (e.target === walletModal) walletModal.classList.remove('show');
  });

  $<HTMLButtonElement>('#connect-wallet-btn').addEventListener('click', showWalletModal);
  const gwb = document.getElementById('game-wallet-btn');
  if (gwb) gwb.addEventListener('click', showWalletModal);

  const profileConnectBtn = document.getElementById('profile-connect-btn');
  if (profileConnectBtn) profileConnectBtn.addEventListener('click', showWalletModal);

  // Disconnect
  const disconnectBtn = document.getElementById('disconnect-wallet-btn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      await disconnectWallet();
      toast('Wallet disconnected', 'info');
    });
  }

  // Profile - save username
  const saveUsernameBtn = document.getElementById('save-username-btn');
  if (saveUsernameBtn) {
    saveUsernameBtn.addEventListener('click', async () => {
      const input = $<HTMLInputElement>('#profile-username-input');
      const username = input.value.trim();
      if (!username) return;
      const user = await updateProfile({ username });
      if (user) {
        toast('Username updated!', 'success');
        myName = user.username;
        
      }
    });
  }

  // Profile - avatar upload
  const avatarWrapper = document.getElementById('avatar-wrapper');
  const avatarInput = document.getElementById('avatar-input') as HTMLInputElement;
  if (avatarWrapper && avatarInput) {
    avatarWrapper.addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Max 2MB', 'error'); return; }
      toast('Uploading avatar...', 'info');
      const user = await uploadAvatar(file);
      if (user) toast('Avatar updated!', 'success');
      else toast('Upload failed', 'error');
    });
  }

  // Profile - copy wallet
  const profileWallet = document.getElementById('profile-wallet');
  if (profileWallet) {
    profileWallet.addEventListener('click', () => {
      const auth = getAuthState();
      if (auth.wallet) {
        navigator.clipboard.writeText(auth.wallet).then(() => toast('Copied!', 'success'));
      }
    });
  }

  // Auth state listener - update UI
  onAuthChange((auth) => {
    updateWalletUI(auth.connected, auth.user);
  });

  // Sidebar nav
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      btn.classList.add('active');
      const nav = btn.dataset.nav;

      // Show/hide sections
      const matchesSection = document.querySelector('.matches-section') as HTMLElement;
      const customSection = document.querySelector('.custom-section') as HTMLElement;
      const nameRow = document.querySelector('.lobby-name-row') as HTMLElement;
      const profileSection = document.getElementById('profile-section') as HTMLElement;
      const avatarPickerSection = document.getElementById('avatar-picker-section') as HTMLElement;

      if (nav === 'play') {
        if (matchesSection) matchesSection.style.display = '';
        if (customSection) customSection.style.display = '';
        if (nameRow) nameRow.style.display = '';
        if (avatarPickerSection) avatarPickerSection.style.display = '';
        if (profileSection) profileSection.classList.remove('active');
        hideLeaderboard();
      } else if (nav === 'profile') {
        if (matchesSection) matchesSection.style.display = 'none';
        if (customSection) customSection.style.display = 'none';
        if (nameRow) nameRow.style.display = 'none';
        if (avatarPickerSection) avatarPickerSection.style.display = 'none';
        if (profileSection) profileSection.classList.add('active');
      } else if (nav === 'leaderboard') {
        if (matchesSection) matchesSection.style.display = 'none';
        if (customSection) customSection.style.display = 'none';
        if (nameRow) nameRow.style.display = 'none';
        if (avatarPickerSection) avatarPickerSection.style.display = 'none';
        if (profileSection) profileSection.classList.remove('active');
        showLeaderboard();
      } else {
        toast(((nav || '').charAt(0).toUpperCase() + (nav || '').slice(1)) + ' — coming soon', 'info');
      }
    });
  });

  // Room — Leave
  $<HTMLButtonElement>('#leave-room-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    currentRoom = null; isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showScreen('lobby');
    startMatchesPolling();
    toast('Left room', 'info');
  });

  // Room — Copy code
  $<HTMLElement>('#room-code-value').addEventListener('click', () => {
    const code = currentRoom?.code ?? '';
    navigator.clipboard.writeText(code).then(() => toast(`Copied: ${code}`, 'success'));
  });

  // Room — Teams
  document.querySelectorAll<HTMLButtonElement>('.btn-team').forEach(btn => {
    btn.addEventListener('click', () => { socket.emit('changeTeam', btn.dataset.team as Team); });
  });

  // Room chat
  function sendRoomChat() {
    const input = $<HTMLInputElement>('#room-chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chatMessage', text); input.value = '';
  }
  $<HTMLButtonElement>('#room-chat-send').addEventListener('click', sendRoomChat);
  $<HTMLInputElement>('#room-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendRoomChat(); } });

  // Game chat
  function sendGameChat() {
    const input = $<HTMLInputElement>('#game-chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chatMessage', text); input.value = '';
  }
  $<HTMLButtonElement>('#game-chat-send').addEventListener('click', sendGameChat);
  $<HTMLInputElement>('#game-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendGameChat(); } });

  // Game — Leave
  $<HTMLButtonElement>('#game-leave-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    currentRoom = null; isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showScreen('lobby');
    startMatchesPolling();
    toast('Left match', 'info');
  });

  // Game — Copy room code
  const topbarCode = document.getElementById('topbar-room-code');
  if (topbarCode) {
    topbarCode.addEventListener('click', () => {
      const code = currentRoom?.code ?? '';
      navigator.clipboard.writeText(code).then(() => toast(`Copied: ${code}`, 'success'));
    });
  }

  // Fullscreen
  const fsBtn = document.getElementById('fullscreen-btn');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Resize
  window.addEventListener('resize', () => {
    if (renderer && isInGame) renderer.resize();
  });
}

// ===== RENDER LOOP =====
function startRenderLoop() {
  const canvas = $<HTMLCanvasElement>('#game-canvas');
  renderer = new Renderer(canvas);

  function frame() {
    if (isInGame && targetState) {
      const elapsed = performance.now() - lastStateTime;
      const alpha = Math.min(elapsed / SERVER_TICK_MS, 1);
      renderer!.renderInterpolated(prevState, targetState, alpha);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ===== INIT =====
function updateWalletUI(connected: boolean, user: UserProfile | null) {
  // Update all wallet buttons
  const walletBtns = document.querySelectorAll('.wallet-btn');
  walletBtns.forEach(btn => {
    if (connected && user) {
      btn.textContent = user.wallet_address.slice(0, 4) + '...' + user.wallet_address.slice(-4);
      (btn as HTMLElement).style.fontSize = '10px';
    } else {
      btn.textContent = '🔗 Connect Wallet';
      (btn as HTMLElement).style.fontSize = '';
    }
  });

  // Update sidebar user info
  const usernames = document.querySelectorAll('.user-name');
  const handles = document.querySelectorAll('.user-handle');
  const lvlBadges = document.querySelectorAll('.lvl-badge');
  const avatarEls = document.querySelectorAll('.user-avatar');

  if (connected && user) {
    usernames.forEach(el => el.textContent = user.username);
    handles.forEach(el => el.textContent = '@' + user.wallet_address.slice(0, 6));
    lvlBadges.forEach(el => el.textContent = 'LVL ' + user.level);

    if (user.avatar_data) {
      const url = user.avatar_data;
      avatarEls.forEach(el => {
        if (url) el.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />';
      });
    }
  } else {
    usernames.forEach(el => el.textContent = 'Guest');
    handles.forEach(el => el.textContent = '@anonymous');
    lvlBadges.forEach(el => el.textContent = 'LVL 1');
    avatarEls.forEach(el => el.textContent = '💊');
  }

  // Update profile page
  const profileConnected = document.getElementById('profile-connected');
  const profileNotConnected = document.getElementById('profile-not-connected');
  if (profileConnected && profileNotConnected) {
    if (connected && user) {
      profileConnected.style.display = '';
      profileNotConnected.style.display = 'none';

      const pName = document.getElementById('profile-display-name');
      if (pName) pName.textContent = user.username;

      const pWallet = document.getElementById('profile-wallet');
      if (pWallet) pWallet.textContent = user.wallet_address.slice(0, 8) + '...' + user.wallet_address.slice(-6);

      const pAvatar = document.getElementById('profile-avatar');
      if (pAvatar && user.avatar_data) {
        const url = user.avatar_data;
        if (url) pAvatar.innerHTML = '<img src="' + url + '" />';
      }

      const sGames = document.getElementById('stat-games');
      const sWins = document.getElementById('stat-wins');
      const sGoals = document.getElementById('stat-goals');
      const sLevel = document.getElementById('stat-level');
      if (sGames) sGames.textContent = String(user.games_played);
      if (sWins) sWins.textContent = String(user.games_won);
      if (sGoals) sGoals.textContent = String(user.goals_scored);
      if (sLevel) sLevel.textContent = String(user.level);

      const usernameInput = document.getElementById('profile-username-input') as HTMLInputElement;
      if (usernameInput) usernameInput.value = user.username;
    } else {
      profileConnected.style.display = 'none';
      profileNotConnected.style.display = '';
    }
  }
}

function init() {
  generateDefaultAvatars();
  buildUI();
  setupSocket();
  setupKeyboard();
  setupEventListeners();
  renderAvatarPicker();
  startRenderLoop();
  renderSkeletonCards();
  startMatchesPolling();

  // Restore wallet session if token exists
  restoreSession().then(ok => {
    if (ok) {
      const auth = getAuthState();
      updateWalletUI(auth.connected, auth.user);
      if (auth.user) {
        myName = auth.user.username;
      }
    }
  });
}

function isMobileOrTablet(): boolean {
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(navigator.userAgent) || window.innerWidth < 1024;
}

if (isMobileOrTablet()) {
  document.getElementById('app')!.innerHTML = `
    <div style="min-height:100vh;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;text-align:center;font-family:sans-serif">
      <img src="/logo-full.png" alt="PumpBall" style="width:120px;margin-bottom:24px;opacity:0.9" />
      <div style="color:#00ff88;font-size:24px;font-weight:900;letter-spacing:3px;margin-bottom:12px">PUMPBALL</div>
      <div style="color:#fff;font-size:16px;font-weight:600;margin-bottom:8px">Desktop Only</div>
      <div style="color:#888;font-size:13px;max-width:280px;line-height:1.6">This game requires a keyboard and mouse.<br>Please open on a desktop browser.</div>
    </div>
  `;
} else {
  init();
}
