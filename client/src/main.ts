import './styles.css';
import { io, Socket } from 'socket.io-client';
import { Renderer } from './renderer';
import type { GameState, RoomInfo, ChatMessage, Team, Keyboard } from './types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// ===== STATE =====
let socket: Socket;
let myId = '';
let myName = '';
let myTeam: Team = 'spectator';
let currentRoom: RoomInfo | null = null;
let renderer: Renderer | null = null;
let isInGame = false;

// Keyboard state
const keys: Keyboard = {
  rightClicked: false,
  leftClicked: false,
  upClicked: false,
  downClicked: false,
  spaceClicked: false,
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

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playSound(freq: number, duration: number, type: OscillatorType = 'sine', vol = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Audio not available
  }
}

function playGoalSound() {
  playSound(440, 0.15, 'square', 0.2);
  setTimeout(() => playSound(660, 0.15, 'square', 0.2), 150);
  setTimeout(() => playSound(880, 0.3, 'square', 0.2), 300);
}

function playKickSound() {
  playSound(200, 0.08, 'sawtooth', 0.1);
}

// ===== CHAT =====
function addChatMessage(
  container: HTMLElement,
  msg: ChatMessage,
  team?: Team,
) {
  const div = document.createElement('div');
  div.className = 'chat-msg';

  const nameSpan = document.createElement('span');
  nameSpan.className = `msg-name ${team ?? 'spectator'}`;
  nameSpan.textContent = msg.playerName + ':';

  const textSpan = document.createElement('span');
  textSpan.className = 'msg-text';
  textSpan.textContent = ' ' + msg.text;

  div.appendChild(nameSpan);
  div.appendChild(textSpan);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addSystemMessage(container: HTMLElement, text: string) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const span = document.createElement('span');
  span.className = 'msg-name system';
  span.textContent = '⚡ ' + text;
  div.appendChild(span);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ===== ROOM SCREEN UI =====
function renderRoomInfo(info: RoomInfo) {
  currentRoom = info;
  const isHost = info.hostId === myId;

  // Room code
  $<HTMLElement>('#room-code-value').textContent = info.code;

  // Start button visibility
  const startBtn = $<HTMLButtonElement>('#start-game-btn');
  startBtn.style.display = isHost ? 'block' : 'none';

  // Team slots
  const redSlots = $<HTMLElement>('#red-slots');
  const blueSlots = $<HTMLElement>('#blue-slots');
  const spectatorList = $<HTMLElement>('#spectator-list');

  const redPlayers = info.players.filter((p) => p.team === 'red');
  const bluePlayers = info.players.filter((p) => p.team === 'blue');
  const spectators = info.players.filter((p) => p.team === 'spectator');

  redSlots.innerHTML = '';
  bluePlayers.forEach === undefined; // type check
  [0, 1, 2].forEach((i) => {
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
  [0, 1, 2].forEach((i) => {
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
  spectators.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'spectator-item';
    div.textContent = p.name + (p.id === myId ? ' (you)' : '') + (p.id === info.hostId ? ' 👑' : '');
    spectatorList.appendChild(div);
  });

  // Highlight active team button
  const myPlayer = info.players.find((p) => p.id === myId);
  myTeam = myPlayer?.team ?? 'spectator';
  document.querySelectorAll('.btn-team').forEach((btn) => btn.classList.remove('active'));
  const activeBtn = $<HTMLElement>(`.btn-team.${myTeam === 'spectator' ? 'spec' : myTeam}`);
  if (activeBtn) activeBtn.classList.add('active');
}

function renderGamePlayers(state: GameState) {
  const list = $<HTMLElement>('#game-player-list');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'game-player-item';

    const dot = document.createElement('div');
    dot.className = `dot ${p.team}`;

    const name = document.createElement('div');
    name.className = 'pname';
    name.textContent = p.name + (p.id === myId ? ' ★' : '');

    div.appendChild(dot);
    div.appendChild(name);
    list.appendChild(div);
  });
}

// ===== KEYBOARD INPUT =====
function setupKeyboard() {
  const keyMap: Record<string, keyof Keyboard> = {
    ArrowRight: 'rightClicked',
    ArrowLeft: 'leftClicked',
    ArrowUp: 'upClicked',
    ArrowDown: 'downClicked',
    ' ': 'spaceClicked',
    d: 'rightClicked',
    a: 'leftClicked',
    w: 'upClicked',
    s: 'downClicked',
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
    if (inputSendTimer) {
      clearInterval(inputSendTimer);
      inputSendTimer = null;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!isInGame) return;
    // Don't capture keys when typing in chat
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

  // Start input loop when game starts
  document.addEventListener('gameStarted', () => startInput());
  document.addEventListener('gameStopped', () => {
    stopInput();
    Object.keys(keys).forEach((k) => { (keys as Record<string, boolean>)[k] = false; });
  });
}

// ===== SOCKET SETUP =====
function setupSocket() {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    myId = socket.id ?? '';
    if (renderer) renderer.setMyId(myId);
    toast('Connected to server', 'success');
  });

  socket.on('disconnect', () => {
    toast('Disconnected from server', 'error');
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showScreen('lobby');
  });

  socket.on('roomJoined', (info: RoomInfo) => {
    currentRoom = info;
    showScreen('room');
    renderRoomInfo(info);

    const roomChat = $<HTMLElement>('#room-chat-messages');
    roomChat.innerHTML = '';
    addSystemMessage(roomChat, `You joined room ${info.code}`);
  });

  socket.on('roomUpdated', (info: RoomInfo) => {
    currentRoom = info;
    if (!isInGame) {
      renderRoomInfo(info);
    } else {
      // Update my team reference
      const me = info.players.find((p) => p.id === myId);
      if (me) myTeam = me.team;
    }
  });

  socket.on('gameStarted', () => {
    isInGame = true;
    document.dispatchEvent(new Event('gameStarted'));
    showScreen('game');

    if (renderer) {
      renderer.resize();
    }

    $<HTMLElement>('#game-hud-code').textContent = currentRoom?.code ?? '';

    const gameChat = $<HTMLElement>('#game-chat-messages');
    gameChat.innerHTML = '';
    addSystemMessage(gameChat, 'Game started! Good luck!');
  });

  socket.on('gameState', (state: GameState) => {
    if (!isInGame) return;

    renderer?.render(state);

    // Update score
    $<HTMLElement>('#score-red').textContent = String(state.score.red);
    $<HTMLElement>('#score-blue').textContent = String(state.score.blue);

    renderGamePlayers(state);
  });

  socket.on('goal', (data: { team: Team; score: { red: number; blue: number } }) => {
    playGoalSound();
    showGoalOverlay(data.team, data.score);

    // Update score
    $<HTMLElement>('#score-red').textContent = String(data.score.red);
    $<HTMLElement>('#score-blue').textContent = String(data.score.blue);

    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.team === 'red' ? '🔴 RED' : '🔵 BLUE';
    addSystemMessage(gameChat, `GOAL! ${teamName} scores! ${data.score.red} - ${data.score.blue}`);
  });

  socket.on('gameOver', (data: { winner: Team; score: { red: number; blue: number } }) => {
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showGameOver(data.winner, data.score);

    const gameChat = $<HTMLElement>('#game-chat-messages');
    const teamName = data.winner === 'red' ? 'RED' : 'BLUE';
    addSystemMessage(gameChat, `GAME OVER! ${teamName} WINS! Final: ${data.score.red} - ${data.score.blue}`);

    setTimeout(() => {
      hideGameOver();
      showScreen('room');
      if (currentRoom) {
        // Reset room status for display
        currentRoom.status = 'waiting';
        renderRoomInfo(currentRoom);
      }
    }, 4000);
  });

  socket.on('chatMessage', (msg: ChatMessage) => {
    const roomChat = $<HTMLElement>('#room-chat-messages');
    const gameChat = $<HTMLElement>('#game-chat-messages');

    const senderTeam = currentRoom?.players.find((p) => p.name === msg.playerName)?.team;

    if (!isInGame) {
      addChatMessage(roomChat, msg, senderTeam);
    }
    addChatMessage(gameChat, msg, senderTeam);
  });

  socket.on('error', (message: string) => {
    toast(message, 'error');
  });
}

// ===== GOAL OVERLAY =====
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

function hideGameOver() {
  $<HTMLElement>('#gameover-overlay').classList.remove('show');
}

// ===== HTML TEMPLATE =====
function buildUI() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <!-- LOBBY SCREEN -->
    <div id="lobby-screen" class="screen active">
      <div class="lobby-container">
        <div class="logo">
          <h1>PUMPBALL</h1>
          <div class="tagline">Kick it. Bet it. Degen it.</div>
        </div>

        <div class="input-group">
          <div class="section-label">Your name</div>
          <input type="text" id="player-name-input" placeholder="Enter your name..." maxlength="20" />
        </div>

        <div>
          <button id="create-room-btn" class="btn btn-primary">Create Room</button>
        </div>

        <div class="divider">or join</div>

        <div class="input-group">
          <div class="section-label">Room code</div>
          <div class="join-row">
            <input type="text" id="join-code-input" placeholder="PUMP42" maxlength="6" />
            <button id="join-room-btn" class="btn btn-secondary">Join</button>
          </div>
        </div>

        <div id="lobby-error" class="error-msg"></div>
      </div>
    </div>

    <!-- ROOM SCREEN -->
    <div id="room-screen" class="screen">
      <div class="room-layout">
        <!-- Sidebar -->
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
                  <div class="team-title red">RED 🔴</div>
                  <div id="red-slots"></div>
                </div>
                <div class="team-column">
                  <div class="team-title blue">BLUE 🔵</div>
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

        <!-- Chat -->
        <div class="chat-panel">
          <div class="chat-header">
            <span class="status-dot"></span>Room Chat
          </div>
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
      <div class="game-layout">
        <div class="game-hud">
          <div class="score-display">
            <span id="score-red" class="score-red">0</span>
            <span class="score-sep">—</span>
            <span id="score-blue" class="score-blue">0</span>
          </div>
          <div class="hud-info">
            <div class="hud-code" id="game-hud-code">------</div>
            <div>First to 5 wins</div>
          </div>
        </div>
        <div class="canvas-container">
          <canvas id="game-canvas"></canvas>
        </div>
      </div>

      <!-- Game Sidebar -->
      <div class="game-sidebar">
        <div class="game-players-panel">
          <div class="section-label">Players</div>
          <div id="game-player-list" class="game-player-list"></div>
        </div>

        <div class="chat-panel" style="border-left:none; flex:1;">
          <div class="chat-header">
            <span class="status-dot"></span>Chat
          </div>
          <div id="game-chat-messages" class="chat-messages"></div>
          <div class="chat-input-row">
            <input type="text" id="game-chat-input" placeholder="Enter to chat..." maxlength="200" />
            <button id="game-chat-send" class="btn btn-secondary btn-sm">Send</button>
          </div>
        </div>

        <div class="controls-hint">
          <kbd>↑↓←→</kbd> or <kbd>WASD</kbd> move<br/>
          <kbd>Space</kbd> or <kbd>X</kbd> kick
        </div>
      </div>
    </div>

    <!-- GOAL OVERLAY -->
    <div id="goal-overlay" class="goal-overlay">
      <div class="goal-banner">
        <div id="goal-text" class="goal-text red">GOAL!</div>
        <div id="goal-sub" class="goal-sub">0 — 0</div>
      </div>
    </div>

    <!-- GAME OVER OVERLAY -->
    <div id="gameover-overlay" class="gameover-overlay">
      <div class="gameover-banner">
        <div id="winner-text" class="winner-text red">RED WINS</div>
        <div id="gameover-score" class="final-score">5 — 0</div>
        <div class="gameover-sub">Returning to lobby...</div>
      </div>
    </div>

    <!-- TOAST CONTAINER -->
    <div id="toast-container" class="toast-container"></div>
  `;
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Lobby — Create room
  $<HTMLButtonElement>('#create-room-btn').addEventListener('click', () => {
    const name = $<HTMLInputElement>('#player-name-input').value.trim() || 'Player';
    myName = name;
    $<HTMLElement>('#lobby-error').textContent = '';

    socket.emit('createRoom', name, (roomCode: string) => {
      toast(`Room ${roomCode} created!`, 'success');
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
      addSystemMessage(roomChat, `Room ${roomCode} created! Share the code with friends.`);
    });
  });

  // Lobby — Join room
  $<HTMLButtonElement>('#join-room-btn').addEventListener('click', joinRoom);
  $<HTMLInputElement>('#join-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  function joinRoom() {
    const name = $<HTMLInputElement>('#player-name-input').value.trim() || 'Player';
    const code = $<HTMLInputElement>('#join-code-input').value.trim().toUpperCase();
    const errEl = $<HTMLElement>('#lobby-error');

    if (!code) {
      errEl.textContent = 'Enter a room code';
      return;
    }

    myName = name;
    errEl.textContent = '';

    socket.emit('joinRoom', { roomCode: code, name }, (success: boolean, error?: string) => {
      if (!success) {
        errEl.textContent = error ?? 'Could not join room';
        toast(error ?? 'Could not join room', 'error');
      }
    });
  }

  // Room — Leave
  $<HTMLButtonElement>('#leave-room-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    currentRoom = null;
    isInGame = false;
    document.dispatchEvent(new Event('gameStopped'));
    showScreen('lobby');
    toast('Left room', 'info');
  });

  // Room — Start game
  $<HTMLButtonElement>('#start-game-btn').addEventListener('click', () => {
    socket.emit('startGame');
  });

  // Room — Copy code
  $<HTMLElement>('#room-code-value').addEventListener('click', () => {
    const code = currentRoom?.code ?? '';
    navigator.clipboard.writeText(code).then(() => toast(`Copied: ${code}`, 'success'));
  });

  // Room — Team buttons
  document.querySelectorAll<HTMLButtonElement>('.btn-team').forEach((btn) => {
    btn.addEventListener('click', () => {
      const team = btn.dataset.team as Team;
      socket.emit('changeTeam', team);
    });
  });

  // Room — Chat
  function sendRoomChat() {
    const input = $<HTMLInputElement>('#room-chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chatMessage', text);
    input.value = '';
  }

  $<HTMLButtonElement>('#room-chat-send').addEventListener('click', sendRoomChat);
  $<HTMLInputElement>('#room-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendRoomChat();
    }
  });

  // Game — Chat
  function sendGameChat() {
    const input = $<HTMLInputElement>('#game-chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chatMessage', text);
    input.value = '';
  }

  $<HTMLButtonElement>('#game-chat-send').addEventListener('click', sendGameChat);
  $<HTMLInputElement>('#game-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendGameChat();
    }
  });

  // Enter key in name input → create room
  $<HTMLInputElement>('#player-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      $<HTMLButtonElement>('#create-room-btn').click();
    }
  });

  // Resize canvas
  window.addEventListener('resize', () => {
    if (renderer && isInGame) {
      renderer.resize();
    }
  });
}

// ===== INIT =====
function init() {
  buildUI();

  const canvas = $<HTMLCanvasElement>('#game-canvas');
  renderer = new Renderer(canvas);

  setupKeyboard();
  setupSocket();
  setupEventListeners();

  // Set socket ID when available
  setTimeout(() => {
    if (socket.id) {
      myId = socket.id;
      renderer?.setMyId(myId);
    }
  }, 500);
}

init();
