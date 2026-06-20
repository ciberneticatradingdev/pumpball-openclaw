import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Room } from './room';
import { generateNonce, verifySignature, createToken, verifyToken } from './auth';
import { getUserById, setUsername, setAvatar, getLeaderboard, initDB, addGameStats, getRecentXpLeaderboard, getTotalRecentXp, recordRoomWin, getRoomWins, markRoomWinRewarded } from './database';

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
const socketToUser = new Map<string, string>(); // socketId -> userId (wallet-authed)
const roomAuthenticatedPlayers = new Map<string, Set<string>>(); // roomCode -> Set<socketId>

// Persist PUMP-1 wins for manual rewards
async function handleRoomGameOver(
  code: string,
  winner: 'red' | 'blue',
  score: { red: number; blue: number },
  players: Array<{ id: string; name: string; team: 'red' | 'blue' | 'spectator' }>,
) {
  if (code !== 'PUMP-1') return;
  const winners = players.filter(p => p.team === winner);
  for (const p of winners) {
    const userId = socketToUser.get(p.id);
    if (!userId) continue;
    const user = await getUserById(userId).catch(() => null);
    if (!user) continue;
    await recordRoomWin(code, winner, user.wallet_address, p.name, score.red, score.blue).catch(() => {});
  }
}

// Reconnection state
const reconnectData = new Map<string, { socketId: string; roomCode: string; playerName: string; avatarData?: string }>();
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
const socketToToken = new Map<string, string>();

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
    const room = new Room(code, '', '', io, { persistent: true, mode, onGameOver: handleRoomGameOver });
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

  // Issue a reconnect token for this connection
  const token = crypto.randomUUID();
  socketToToken.set(socket.id, token);
  socket.emit('reconnectToken', token);

  // Wallet identification: client sends its JWT so we can credit game XP to the
  // authenticated user account (used for the daily token reward distribution).
  socket.on('identify', (data: { token?: string }) => {
    if (!data || typeof data.token !== 'string') return;
    const payload = verifyToken(data.token);
    if (payload?.userId) {
      socketToUser.set(socket.id, payload.userId);
    }
  });

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
    const room = new Room(code, socket.id, playerName, io, { mode: '4v4', onGameOver: handleRoomGameOver });
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
      data: { roomCode: string; name: string; avatarData?: string; token?: string },
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

      // PUMP-1, PUMP-4, PUMP-7: wallet-auth required to play (not to spectate)
      const restrictedRooms = ['PUMP-1'];
      const isRestricted = restrictedRooms.includes(roomCode);
      const token = typeof data.token === 'string' ? data.token : undefined;
      const payload = token ? verifyToken(token) : null;
      const canPlay = isRestricted ? !!payload?.userId : true;
      if (payload?.userId) socketToUser.set(socket.id, payload.userId);

      // Track who is allowed to play in restricted rooms
      if (isRestricted && canPlay) {
        if (!roomAuthenticatedPlayers.has(roomCode)) roomAuthenticatedPlayers.set(roomCode, new Set());
        roomAuthenticatedPlayers.get(roomCode)!.add(socket.id);
      }

      // Always allow joining; unauthenticated users in restricted rooms spectate only
      const success = room.addPlayer(socket.id, playerName, avatarData, { spectatorOnly: isRestricted && !canPlay });
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
    handleLeave(socket.id, true); // immediate — intentional leave
  });

  socket.on('changeTeam', (team: Team) => {
    if (!['red', 'blue', 'spectator'].includes(team)) return;
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const restrictedRooms = ['PUMP-1'];
    if (restrictedRooms.includes(code) && team !== 'spectator') {
      const authed = roomAuthenticatedPlayers.get(code);
      if (!authed?.has(socket.id)) return;
    }
    const room = rooms.get(code);
    room?.changeTeam(socket.id, team);
  });

  socket.on('playerInput', (keyboard: Keyboard) => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    room?.updateInput(socket.id, keyboard);
  });

  socket.on('acceptRematch', () => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    room?.acceptRematch(socket.id);
  });

  socket.on('declineRematch', () => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    room?.declineRematch(socket.id);
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

  // Reconnection: client sends back its stored token after a new connection
  socket.on('reconnect_attempt', (data: { token: string }) => {
    if (!data || typeof data.token !== 'string') return;
    const rd = reconnectData.get(data.token);
    if (!rd) return;

    const room = rooms.get(rd.roomCode);
    if (!room || !room.hasPlayer(rd.socketId)) return;

    // Cancel the pending removal timeout
    const timeout = pendingDisconnects.get(rd.socketId);
    if (timeout) {
      clearTimeout(timeout);
      pendingDisconnects.delete(rd.socketId);
    }

    const oldSocketId = rd.socketId;
    const newSocketId = socket.id;

    // Restore player data in room and physics
    const roomInfo = room.restorePlayer(oldSocketId, newSocketId);
    if (!roomInfo) return;

    // Clean up old token data and set up new token data
    reconnectData.delete(data.token);
    const newToken = socketToToken.get(newSocketId);
    if (newToken) {
      reconnectData.set(newToken, {
        socketId: newSocketId,
        roomCode: rd.roomCode,
        playerName: rd.playerName,
        avatarData: rd.avatarData,
      });
    }

    // Update player room mapping
    playerRooms.delete(oldSocketId);
    playerRooms.set(newSocketId, rd.roomCode);

    // Re-join the socket room
    socket.join(room.roomKey);

    socket.emit('reconnected', roomInfo);
    console.log(`[R] ${rd.playerName} reconnected: ${oldSocketId} -> ${newSocketId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
    socketToUser.delete(socket.id);
    handleLeave(socket.id, false); // grace period — may reconnect
  });

  function handleLeave(socketId: string, immediate: boolean = true) {
    const code = playerRooms.get(socketId);
    // Clean up restricted-room auth tracking
    if (code) {
      const authed = roomAuthenticatedPlayers.get(code);
      if (authed) {
        authed.delete(socketId);
        if (authed.size === 0) roomAuthenticatedPlayers.delete(code);
      }
    }
    if (!code) {
      socketToToken.delete(socketId);
      return;
    }

    const room = rooms.get(code);
    const existingToken = socketToToken.get(socketId);

    if (!immediate && room && existingToken) {
      // Grace period: suspend player, schedule removal in 15s
      const playerInfo = room.getRoomInfo().players.find(p => p.id === socketId);
      room.suspendPlayer(socketId);

      reconnectData.set(existingToken, {
        socketId,
        roomCode: code,
        playerName: playerInfo?.name || '',
        avatarData: playerInfo?.avatarData,
      });

      const timeout = setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.hasPlayer(socketId)) {
          r.removePlayer(socketId);
          if (r.isEmpty() && !r.persistent) {
            rooms.delete(code);
            console.log(`[-] Room ${code} deleted (empty)`);
          }
        }
        playerRooms.delete(socketId);
        reconnectData.delete(existingToken);
        pendingDisconnects.delete(socketId);
        socketToToken.delete(socketId);
      }, 15000);

      pendingDisconnects.set(socketId, timeout);
    } else {
      // Immediate removal
      if (room) {
        room.removePlayer(socketId);
        if (room.isEmpty() && !room.persistent) {
          rooms.delete(code);
          console.log(`[-] Room ${code} deleted (empty)`);
        }
      }
      playerRooms.delete(socketId);

      // Cancel any pending grace-period timeout for this socket
      if (existingToken) {
        const pt = pendingDisconnects.get(socketId);
        if (pt) { clearTimeout(pt); pendingDisconnects.delete(socketId); }
        reconnectData.delete(existingToken);
        socketToToken.delete(socketId);
      }
    }

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

// PUMP-1 wins ledger (for manual rewards)
app.get('/api/room-wins', async (req, res) => {
  const roomCode = typeof req.query.room === 'string' ? req.query.room : 'PUMP-1';
  const onlyUnrewarded = req.query.unrewarded === 'true';
  const limit = Math.min(1000, parseInt(req.query.limit as string, 10) || 100);
  const wins = await getRoomWins(roomCode, onlyUnrewarded, limit);
  res.json({ room: roomCode, wins });
});

app.post('/api/room-wins/:id/rewarded', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  await markRoomWinRewarded(id);
  res.json({ success: true });
});

// Initialize database then start
initDB().then(() => console.log('DB initialized')).catch(e => console.warn('DB init failed:', e));

createPersistentRooms();

httpServer.listen(PORT, () => {
  console.log(`\n⚡ PumpBall server running on http://localhost:${PORT}\n`);
});
