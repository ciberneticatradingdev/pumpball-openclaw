import './styles.css';
import { io, Socket } from 'socket.io-client';
import { Renderer } from './renderer';
import type { GameState, RoomInfo, ChatMessage, Team, Keyboard } from './types';
import { connectWithProvider, disconnectWallet, restoreSession, updateProfile, uploadAvatar, onAuthChange, getAuthState, getAvatarUrl, getAvailableWallets, type UserProfile } from './wallet';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// ===== STATE =====
let socket: Socket;
let myId = '';
let myName = '';
let myTeam: Team = 'spectator';
let currentRoom: RoomInfo | null = null;
let renderer: Renderer | null = null;
let isInGame = false;
let matchesInterval: ReturnType<typeof setInterval> | null = null;

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

// ===== CHAT =====
function addChatMessage(container: HTMLElement, msg: ChatMessage, team?: Team) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const nameSpan = document.createElement('span');
  nameSpan.className = `msg-name ${team ?? 'spectator'}`;
  nameSpan.textContent = msg.playerName + ':';
  const textSpan = document.createElement('span');
  textSpan.className = 'msg-text';
  textSpan.textContent = ' ' + msg.text;
  div.appendChild(nameSpan); div.appendChild(textSpan);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addSystemMessage(container: HTMLElement, text: string) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const span = document.createElement('span');
  span.className = 'msg-name system';
  span.textContent = '⚡ ' + text;
  div.appendChild(span); container.appendChild(div);
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
  for (let i = 0; i < 6; i++) {
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

  matches.forEach((m: any, i: number) => {
    const card = document.createElement('div');
    card.className = 'match-card';
    const statusClass = m.status === 'playing' ? 'playing' : 'waiting';
    const statusText = m.status === 'playing' ? '● LIVE' : 'OPEN';

    card.innerHTML = `
      <div class="match-card-header">
        <span class="match-id">MATCH #${i + 1}</span>
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
          <span class="team-label red">RED</span>
          <span class="team-count">${m.redPlayers}</span>
        </div>
        <span class="match-vs">VS</span>
        <div class="match-team">
          <span class="team-label blue">BLUE</span>
          <span class="team-count">${m.bluePlayers}</span>
        </div>
      </div>
      <div class="match-card-footer">
        <span>3v3 · FREE</span>
        <span>👥 ${m.players}/8</span>
      </div>
    `;

    card.addEventListener('click', () => {
      const name = $<HTMLInputElement>('#player-name-input').value.trim();
      if (!name) {
        toast('Enter your name first', 'error');
        $<HTMLInputElement>('#player-name-input').focus();
        return;
      }
      myName = name;
      socket.emit('joinRoom', { roomCode: m.code, name }, (success: boolean, error?: string) => {
        if (!success) toast(error || 'Could not join', 'error');
      });
    });

    grid.appendChild(card);
  });
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
  const isHost = info.hostId === myId;

  $<HTMLElement>('#room-code-value').textContent = info.code;

  const startBtn = $<HTMLButtonElement>('#start-game-btn');
  startBtn.style.display = isHost ? 'block' : 'none';

  const redSlots = $<HTMLElement>('#red-slots');
  const blueSlots = $<HTMLElement>('#blue-slots');
  const spectatorList = $<HTMLElement>('#spectator-list');

  const redPlayers = info.players.filter(p => p.team === 'red');
  const bluePlayers = info.players.filter(p => p.team === 'blue');
  const spectators = info.players.filter(p => p.team === 'spectator');

  redSlots.innerHTML = '';
  [0, 1, 2].forEach(i => {
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
  });

  blueSlots.innerHTML = '';
  [0, 1, 2].forEach(i => {
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
  });

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
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    myId = socket.id ?? '';
    if (renderer) renderer.setMyId(myId);
    toast('Connected', 'success');
  });

  socket.on('disconnect', () => {
    toast('Disconnected', 'error');
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showScreen('lobby');
    startMatchesPolling();
  });

  socket.on('roomJoined', (info: RoomInfo) => {
    currentRoom = info;
    stopMatchesPolling();
    showScreen('room');
    renderRoomInfo(info);
    const roomChat = $<HTMLElement>('#room-chat-messages');
    roomChat.innerHTML = '';
    addSystemMessage(roomChat, `Joined room ${info.code}`);
  });

  socket.on('roomUpdated', (info: RoomInfo) => {
    currentRoom = info;
    if (!isInGame) {
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
    document.dispatchEvent(new Event('gameStarted'));
    showScreen('game');

    if (renderer) renderer.resize();

    // Update topbar
    const codeEl = document.getElementById('topbar-room-code');
    if (codeEl) codeEl.textContent = currentRoom?.code ?? '';

    // Show/hide start button
    const startBtn = document.getElementById('game-start-btn');
    if (startBtn) startBtn.style.display = 'none';

    const gameChat = $<HTMLElement>('#game-chat-messages');
    gameChat.innerHTML = '';
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

  socket.on('goal', (data: { team: Team; score: { red: number; blue: number } }) => {
    playGoalSound();
    showGoalOverlay(data.team, data.score);
    const sr = document.getElementById('topbar-score-red');
    const sb = document.getElementById('topbar-score-blue');
    if (sr) sr.textContent = String(data.score.red);
    if (sb) sb.textContent = String(data.score.blue);

    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.team === 'red' ? '🔴 RED' : '🔵 BLUE';
    addSystemMessage(gameChat, `GOAL! ${teamName} scores! ${data.score.red} - ${data.score.blue}`);
  });

  socket.on('overtime', () => {
    toast('OVERTIME! 1 minute added!', 'info');
    const gameChat = $<HTMLElement>('#game-chat-messages');
    addSystemMessage(gameChat, '⚡ OVERTIME! 1 extra minute!');
  });

  socket.on('gameOver', (data: { winner: Team | null; score: { red: number; blue: number } }) => {
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));

    if (data.winner) {
      showGameOver(data.winner, data.score);
    } else {
      showGameOver('red', data.score); // draw edge case
    }

    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.winner ? (data.winner === 'red' ? 'RED' : 'BLUE') : 'DRAW';
    addSystemMessage(gameChat, `GAME OVER! ${teamName}${data.winner ? ' WINS!' : '!'} Final: ${data.score.red} - ${data.score.blue}`);

    setTimeout(() => {
      hideGameOver();
      showScreen('lobby');
      startMatchesPolling();
    }, 4000);
  });

  socket.on('chatMessage', (msg: ChatMessage) => {
    const roomChat = document.getElementById('room-chat-messages');
    const gameChat = document.getElementById('game-chat-messages');
    const senderTeam = currentRoom?.players.find(p => p.name === msg.playerName)?.team;

    if (!isInGame && roomChat) addChatMessage(roomChat, msg, senderTeam);
    if (gameChat) addChatMessage(gameChat, msg, senderTeam);
  });

  socket.on('error', (message: string) => { toast(message, 'error'); });
}

// ===== OVERLAYS =====
function showGoalOverlay(team: Team, score: { red: number; blue: number }) {
  const overlay = $<HTMLElement>('#goal-overlay');
  const text = $<HTMLElement>('#goal-text');
  const sub = $<HTMLElement>('#goal-sub');
  text.className = `goal-text ${team}`;
  text.textContent = 'GOAL!';
  sub.textContent = `${score.red} — ${score.blue}`;
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 1500);
}

function showGameOver(winner: Team, score: { red: number; blue: number }) {
  const overlay = $<HTMLElement>('#gameover-overlay');
  const text = $<HTMLElement>('#winner-text');
  const finalScore = $<HTMLElement>('#gameover-score');
  text.className = `winner-text ${winner}`;
  text.textContent = `${winner.toUpperCase()} WINS`;
  finalScore.textContent = `${score.red} — ${score.blue}`;
  overlay.classList.add('show');
}

function hideGameOver() { $<HTMLElement>('#gameover-overlay').classList.remove('show'); }

// ===== SIDEBAR HTML (shared) =====
function sidebarHTML(context: 'lobby' | 'game') {
  const cls = context === 'game' ? 'game-left-sidebar' : 'sidebar';
  return `
    <div class="${cls}">
      <div class="sidebar-logo">
        <span class="pill">💊</span>
        <h1>PUMPBALL</h1>
        <div class="tagline">Kick it. Bet it. Degen it.</div>
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
          <h2>PUMPBALL</h2>
          <div class="online-badge">
            <span class="status-dot"></span>
            <span id="online-count">0</span> online
          </div>
        </div>

        <div class="lobby-name-row">
          <input type="text" id="player-name-input" placeholder="Enter your name..." maxlength="20" />
        </div>

        <section class="matches-section">
          <div class="section-heading">
            <h2>Live Matches · 3v3</h2>
            <span class="heading-sub">Free to play</span>
          </div>
          <div id="matches-grid" class="matches-grid"></div>
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
                  <div class="team-title red">RED</div>
                  <div id="red-slots"></div>
                </div>
                <div class="team-column">
                  <div class="team-title blue">BLUE</div>
                  <div id="blue-slots"></div>
                </div>
              </div>
            </div>
            <div class="spectators-section">
              <div class="section-label">Spectators</div>
              <div id="spectator-list"></div>
            </div>
            <div>
              <div class="section-label">Join team</div>
              <div class="team-buttons">
                <button class="btn-team red" data-team="red">Red</button>
                <button class="btn-team blue" data-team="blue">Blue</button>
                <button class="btn-team spec" data-team="spectator">Spec</button>
              </div>
            </div>
          </div>
          <div class="room-footer">
            <button id="start-game-btn" class="btn btn-primary" style="display:none">▶ START GAME</button>
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
          <span class="topbar-logo"><span class="pill">💊</span> PUMPBALL</span>
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
        <div id="winner-text" class="winner-text red">RED WINS</div>
        <div id="gameover-score" class="final-score">5 — 0</div>
        <div class="gameover-sub">Returning to lobby...</div>
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
  `;
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Lobby — Create custom room
  $<HTMLButtonElement>('#create-room-btn').addEventListener('click', () => {
    const name = $<HTMLInputElement>('#player-name-input').value.trim() || 'Player';
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
    const name = $<HTMLInputElement>('#player-name-input').value.trim() || 'Player';
    const code = $<HTMLInputElement>('#join-code-input').value.trim().toUpperCase();
    const errEl = $<HTMLElement>('#lobby-error');
    if (!code) { errEl.textContent = 'Enter a room code'; return; }
    myName = name;
    errEl.textContent = '';
    socket.emit('joinRoom', { roomCode: code, name }, (success: boolean, error?: string) => {
      if (!success) { errEl.textContent = error ?? 'Could not join'; toast(error ?? 'Could not join', 'error'); }
    });
  }

  $<HTMLButtonElement>('#join-room-btn').addEventListener('click', joinRoom);
  $<HTMLInputElement>('#join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

  // === Wallet Connect (with selector modal) ===
  function showWalletModal() {
    const modal = document.getElementById('wallet-modal')!;
    const list = document.getElementById('wallet-list')!;
    const wallets = getAvailableWallets();

    list.innerHTML = '';
    wallets.forEach(w => {
      const btn = document.createElement('button');
      btn.className = 'wallet-option' + (w.installed ? '' : ' not-installed');
      btn.innerHTML = `
        <div class="wallet-icon">${w.icon}</div>
        <span class="wallet-name">${w.name}</span>
        <span class="wallet-tag">${w.installed ? 'DETECTED' : 'INSTALL'}</span>
      `;
      btn.addEventListener('click', async () => {
        if (!w.installed) {
          window.open(w.url, '_blank');
          return;
        }
        modal.classList.remove('show');
        toast('Connecting to ' + w.name + '...', 'info');
        const ok = await connectWithProvider(w.provider);
        if (ok) {
          toast('Connected to ' + w.name + '!', 'success');
          const auth = getAuthState();
          if (auth.user) {
            $<HTMLInputElement>('#player-name-input').value = auth.user.username;
            myName = auth.user.username;
          }
        } else {
          toast('Connection failed or rejected', 'error');
        }
      });
      list.appendChild(btn);
    });

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
        $<HTMLInputElement>('#player-name-input').value = user.username;
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

      if (nav === 'play') {
        if (matchesSection) matchesSection.style.display = '';
        if (customSection) customSection.style.display = '';
        if (nameRow) nameRow.style.display = '';
        if (profileSection) profileSection.classList.remove('active');
      } else if (nav === 'profile') {
        if (matchesSection) matchesSection.style.display = 'none';
        if (customSection) customSection.style.display = 'none';
        if (nameRow) nameRow.style.display = 'none';
        if (profileSection) profileSection.classList.add('active');
      } else if (nav === 'leaderboard') {
        toast('Leaderboard — coming soon', 'info');
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

  // Room — Start
  $<HTMLButtonElement>('#start-game-btn').addEventListener('click', () => { socket.emit('startGame'); });

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

    if (user.avatar_url) {
      const url = getAvatarUrl(user.avatar_url);
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
      if (pAvatar && user.avatar_url) {
        const url = getAvatarUrl(user.avatar_url);
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
  buildUI();
  setupSocket();
  setupKeyboard();
  setupEventListeners();
  startRenderLoop();
  renderSkeletonCards();
  startMatchesPolling();

  // Restore wallet session if token exists
  restoreSession().then(ok => {
    if (ok) {
      const auth = getAuthState();
      updateWalletUI(auth.connected, auth.user);
      if (auth.user) {
        const nameInput = document.getElementById('player-name-input') as HTMLInputElement;
        if (nameInput) nameInput.value = auth.user.username;
        myName = auth.user.username;
      }
    }
  });
}

init();
