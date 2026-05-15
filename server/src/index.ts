import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Room } from './room';
import { generateNonce, verifySignature, createToken, verifyToken } from './auth';
import { getUserById, setUsername, setAvatar, getLeaderboard, initDB } from './database';

const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 5e6, // 5MB — wallet avatars can be large base64
});

const rooms = new Map<string, Room>();
const playerRooms = new Map<string, string>(); // socketId -> roomCode

type Team = 'red' | 'blue' | 'spectator';
type Keyboard = {
  rightClicked: boolean;
  leftClicked: boolean;
  upClicked: boolean;
  downClicked: boolean;
  spaceClicked: boolean;
};

// Persistent rooms: 3x 1v1, 3x 2v2, 3x 4v4
type GameMode = '1v1' | '2v2' | '4v4';
const PERSISTENT_ROOMS: Array<{ code: string; mode: GameMode }> = [
  { code: 'PUMP-1', mode: '1v1' },
  { code: 'PUMP-2', mode: '1v1' },
  { code: 'PUMP-3', mode: '1v1' },
  { code: 'PUMP-4', mode: '2v2' },
  { code: 'PUMP-5', mode: '2v2' },
  { code: 'PUMP-6', mode: '2v2' },
  { code: 'PUMP-7', mode: '4v4' },
  { code: 'PUMP-8', mode: '4v4' },
  { code: 'PUMP-9', mode: '4v4' },
];
const PERSISTENT_CODES = PERSISTENT_ROOMS.map(r => r.code);

function createPersistentRooms() {
  for (const { code, mode } of PERSISTENT_ROOMS) {
    if (rooms.has(code)) continue;
    const room = new Room(code, '', '', io, { persistent: true, mode });
    rooms.set(code, room);
  }
  console.log(`[+] ${PERSISTENT_ROOMS.length} persistent rooms ready: ${PERSISTENT_CODES.join(', ')}`);
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code) || PERSISTENT_CODES.includes(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  socket.on('createRoom', (data: string | { name: string; avatarData?: string }, callback: (roomCode: string) => void) => {
    const code = generateRoomCode();
    let playerName: string;
    let avatarData: string | undefined;
    if (typeof data === 'string') {
      playerName = data.trim() ? data.trim().slice(0, 20) : 'Player';
    } else if (data && typeof data === 'object') {
      playerName = (typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0, 20) : 'Player';
      avatarData = typeof data.avatarData === 'string' ? data.avatarData : undefined;
    } else {
      playerName = 'Player';
    }
    const room = new Room(code, socket.id, playerName, io, { mode: '4v4' });
    rooms.set(code, room);
    playerRooms.set(socket.id, code);
    socket.join(room.roomKey);
    callback(code);
    room.broadcastRoomInfo();
    console.log(`[+] Room created: ${code} by ${playerName} (${socket.id})`);
  });

  socket.on(
    'joinRoom',
    (
      data: { roomCode: string; name: string; avatarData?: string },
      callback: (success: boolean, error?: string) => void,
    ) => {
      if (!data || typeof data !== 'object') return callback(false, 'Invalid data');

      const roomCode = String(data.roomCode || '').toUpperCase().trim();
      const playerName = (typeof data.name === 'string' && data.name.trim())
        ? data.name.trim().slice(0, 20)
        : 'Player';
      const avatarData = typeof data.avatarData === 'string' ? data.avatarData : undefined;

      const room = rooms.get(roomCode);
      if (!room) return callback(false, 'Room not found');
      if (room.hasPlayer(socket.id)) return callback(false, 'Already in this room');

      // Always allow joining (as spectator if game in progress)
      const success = room.addPlayer(socket.id, playerName, avatarData);
      if (!success) return callback(false, 'Could not join room');

      playerRooms.set(socket.id, roomCode);
      socket.join(room.roomKey);
      callback(true);
      socket.emit('roomJoined', room.getRoomInfo());

      // Send existing player avatars to the new joiner
      const existingAvatars = room.getPlayerAvatars();
      if (existingAvatars.length > 0) {
        socket.emit('playerAvatars', existingAvatars);
      }

      // Broadcast new player's avatar to the room
      if (avatarData) {
        socket.to(room.roomKey).emit('playerAvatar', { id: socket.id, avatarData });
      }

      console.log(`[+] ${playerName} (${socket.id}) joined room ${roomCode}`);
    },
  );

  socket.on('leaveRoom', () => {
    handleLeave(socket.id);
  });

  socket.on('changeTeam', (team: Team) => {
    if (!['red', 'blue', 'spectator'].includes(team)) return;
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    room?.changeTeam(socket.id, team);
  });

  socket.on('playerInput', (keyboard: Keyboard) => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    room?.updateInput(socket.id, keyboard);
  });

  socket.on('startGame', () => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const started = room.startGame();
    if (!started) {
      socket.emit('error', 'Need at least 1 player on each team to start');
    }
  });

  socket.on('chatMessage', (text: string) => {
    if (typeof text !== 'string') return;
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const info = room.getRoomInfo();
    const player = info.players.find((p) => p.id === socket.id);
    if (!player) return;

    io.to(room.roomKey).emit('chatMessage', {
      playerName: player.name,
      text: text.trim().slice(0, 200),
      timestamp: Date.now(),
    });
  });


  socket.on('getMatches', (callback: (matches: any[]) => void) => {
    if (typeof callback !== 'function') return;
    const matches = PERSISTENT_CODES.map((code) => {
      const room = rooms.get(code);
      return room ? room.getSummary() : {
        code,
        players: 0,
        redPlayers: 0,
        bluePlayers: 0,
        status: 'waiting' as const,
        score: { red: 0, blue: 0 },
      };
    });
    callback(matches);
  });
  socket.on('ping', (callback: () => void) => {
    if (typeof callback === 'function') callback();
  });

  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    handleLeave(socket.id);
  });

  function handleLeave(socketId: string) {
    const code = playerRooms.get(socketId);
    if (!code) return;

    const room = rooms.get(code);
    if (room) {
      room.removePlayer(socketId);
      if (room.isEmpty() && !room.persistent) {
        rooms.delete(code);
        console.log(`[-] Room ${code} deleted (empty)`);
      }
    }

    playerRooms.delete(socketId);
    socket.leave(`room:${code}`);
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, players: playerRooms.size });
});

app.get('/api/matches', (_req, res) => {
  const matches = PERSISTENT_CODES.map((code) => {
    const room = rooms.get(code);
    return room ? room.getSummary() : {
      code,
      players: 0,
      redPlayers: 0,
      bluePlayers: 0,
      status: 'waiting' as const,
      score: { red: 0, blue: 0 },
    };
  });
  res.json(matches);
});

// === AUTH ROUTES ===
app.post('/api/auth/nonce', (req, res) => {
  const { wallet } = req.body;
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ error: 'wallet required' });
  }
  const nonce = generateNonce(wallet);
  res.json({ nonce });
});

app.post('/api/auth/verify', async (req, res) => {
  const { wallet, signature } = req.body;
  if (!wallet || !signature) {
    return res.status(400).json({ error: 'wallet and signature required' });
  }
  try {
    const user = await verifySignature(wallet, signature);
    if (!user) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const token = createToken(user);
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === PROFILE ROUTES ===
function authMiddleware(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.userId = payload.userId;
  req.wallet = payload.wallet;
  next();
}

app.get('/api/profile', authMiddleware, async (req: any, res) => {
  const user = await getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

app.patch('/api/profile', authMiddleware, async (req: any, res) => {
  const { username } = req.body;
  if (username && typeof username === 'string') {
    await setUsername(req.userId, username);
  }
  const user = await getUserById(req.userId);
  res.json({ user });
});

app.post('/api/profile/avatar', authMiddleware, async (req: any, res) => {
  // Accept base64 JSON body
  try {
    let avatarData: string;
    if (req.is('application/json')) {
      const body = req.body;
      if (!body.avatar) return res.status(400).json({ error: 'No avatar data' });
      avatarData = body.avatar; // expect base64 data URL
    } else {
      return res.status(400).json({ error: 'Send JSON with { avatar: "data:image/..." }' });
    }
    if (avatarData.length > 3 * 1024 * 1024) {
      return res.status(400).json({ error: 'Avatar too large (max 2MB)' });
    }
    await setAvatar(req.userId, avatarData);
    const user = await getUserById(req.userId);
    res.json({ user });
  } catch {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// === LEADERBOARD ===
app.get('/api/leaderboard', async (_req, res) => {
  const players = await getLeaderboard(20);
  res.json({ players });
});

// Initialize database then start
initDB().then(() => console.log('DB initialized')).catch(e => console.warn('DB init failed:', e));

createPersistentRooms();

httpServer.listen(PORT, () => {
  console.log(`\n⚡ PumpBall server running on http://localhost:${PORT}\n`);
});
