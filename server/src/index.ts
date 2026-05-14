import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Room } from './room';

const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
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

// Codes of the 6 always-on persistent matches shown on the landing page
const PERSISTENT_CODES = ['PUMP-1', 'PUMP-2', 'PUMP-3', 'PUMP-4', 'PUMP-5', 'PUMP-6'];

function createPersistentRooms() {
  for (const code of PERSISTENT_CODES) {
    if (rooms.has(code)) continue;
    const room = new Room(code, '', '', io, { persistent: true });
    rooms.set(code, room);
  }
  console.log(`[+] ${PERSISTENT_CODES.length} persistent rooms ready: ${PERSISTENT_CODES.join(', ')}`);
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

  socket.on('createRoom', (name: string, callback: (roomCode: string) => void) => {
    const code = generateRoomCode();
    const playerName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 20) : 'Player';
    const room = new Room(code, socket.id, playerName, io);
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
      data: { roomCode: string; name: string },
      callback: (success: boolean, error?: string) => void,
    ) => {
      if (!data || typeof data !== 'object') return callback(false, 'Invalid data');

      const roomCode = String(data.roomCode || '').toUpperCase().trim();
      const playerName = (typeof data.name === 'string' && data.name.trim())
        ? data.name.trim().slice(0, 20)
        : 'Player';

      const room = rooms.get(roomCode);
      if (!room) return callback(false, 'Room not found');
      if (room.isFull()) return callback(false, 'Room is full');
      if (room.hasPlayer(socket.id)) return callback(false, 'Already in this room');
      if (room.getRoomInfo().status !== 'waiting') return callback(false, 'Game already started');

      const success = room.addPlayer(socket.id, playerName);
      if (!success) return callback(false, 'Could not join room');

      playerRooms.set(socket.id, roomCode);
      socket.join(room.roomKey);
      callback(true);
      socket.emit('roomJoined', room.getRoomInfo());
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
    if (room.hostId !== socket.id) return;

    const started = room.startGame();
    if (!started) {
      socket.emit('error', 'Need at least 2 players assigned to teams to start');
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

createPersistentRooms();

httpServer.listen(PORT, () => {
  console.log(`\n⚡ PumpBall server running on http://localhost:${PORT}\n`);
});
