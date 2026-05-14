import { Server } from 'socket.io';
import { ServerPhysics } from './physics';

type Team = 'red' | 'blue' | 'spectator';

type Keyboard = {
  rightClicked: boolean;
  leftClicked: boolean;
  upClicked: boolean;
  downClicked: boolean;
  spaceClicked: boolean;
};

type RoomPlayerData = {
  id: string;
  name: string;
  team: Team;
};

type RoomInfo = {
  code: string;
  players: RoomPlayerData[];
  hostId: string;
  status: 'waiting' | 'playing' | 'finished';
  score: { red: number; blue: number };
};

type GameState = {
  ball: { x: number; y: number; velocityX: number; velocityY: number };
  players: Array<{
    id: string;
    name: string;
    team: Team;
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    spaceClicked: boolean;
  }>;
  score: { red: number; blue: number };
  status: 'waiting' | 'playing' | 'finished';
  winner?: 'red' | 'blue' | null;
  timeLeft: number;
  overtime: boolean;
};

const PHYSICS_TICK = 1000 / 60;
const BROADCAST_TICK = 1000 / 20;
const MAX_PLAYERS = 8;
const MAX_TEAM_SIZE = 3;
const SCORE_LIMIT = 5;
const MATCH_DURATION = 300;
const OVERTIME_DURATION = 60;

export class Room {
  public code: string;
  public hostId: string;
  public persistent: boolean;
  private status: 'waiting' | 'playing' | 'finished' = 'waiting';
  private players: Map<string, RoomPlayerData> = new Map();
  private score = { red: 0, blue: 0 };
  private physics: ServerPhysics | null = null;
  private physicsInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private io: Server;
  private goalCooldown = false;
  private timeLeft = MATCH_DURATION;
  private overtime = false;

  constructor(
    code: string,
    hostId: string,
    hostName: string,
    io: Server,
    options: { persistent?: boolean } = {},
  ) {
    this.code = code;
    this.hostId = hostId;
    this.io = io;
    this.persistent = !!options.persistent;
    if (hostId) {
      this.players.set(hostId, { id: hostId, name: hostName, team: 'spectator' });
    }
  }

  get roomKey() {
    return `room:${this.code}`;
  }

  addPlayer(id: string, name: string): boolean {
    if (this.players.size >= MAX_PLAYERS) return false;
    if (this.status !== 'waiting') return false;
    this.players.set(id, { id, name, team: 'spectator' });
    // Auto-assign host if persistent room is unhosted
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = id;
    }
    this.broadcastRoomInfo();
    return true;
  }

  removePlayer(id: string): void {
    this.players.delete(id);

    if (id === this.hostId) {
      const next = this.players.keys().next().value as string | undefined;
      if (next) {
        this.hostId = next;
      } else if (this.persistent) {
        // Persistent: keep room alive, reset for next joiners
        this.hostId = '';
        if (this.status === 'playing') this.reset();
        else this.broadcastRoomInfo();
        return;
      } else {
        this.stopGame();
        return;
      }
    }

    if (this.status === 'playing') {
      this.physics?.removePlayer(id);
    }

    this.broadcastRoomInfo();
  }

  changeTeam(id: string, team: Team): void {
    const player = this.players.get(id);
    if (!player) return;

    if (team !== 'spectator') {
      const teamCount = Array.from(this.players.values()).filter(
        (p) => p.team === team && p.id !== id,
      ).length;
      if (teamCount >= MAX_TEAM_SIZE) return;
    }

    player.team = team;
    this.broadcastRoomInfo();
  }

  updateInput(id: string, keyboard: Keyboard): void {
    if (this.status !== 'playing') return;
    const player = this.players.get(id);
    if (!player || player.team === 'spectator') return;
    this.physics?.updateKeyboard(id, keyboard);
  }

  startGame(): boolean {
    const nonSpectators = Array.from(this.players.values()).filter(
      (p) => p.team !== 'spectator',
    );

    if (nonSpectators.length < 2) return false;

    this.status = 'playing';
    this.score = { red: 0, blue: 0 };
    this.goalCooldown = false;
    this.timeLeft = MATCH_DURATION;
    this.overtime = false;

    this.physics = new ServerPhysics((team) => this.handleGoal(team));

    let redIdx = 0;
    let blueIdx = 0;
    for (const player of this.players.values()) {
      if (player.team === 'spectator') continue;
      const idx = player.team === 'red' ? redIdx++ : blueIdx++;
      this.physics.addPlayer(player.id, player.team as 'red' | 'blue', idx);
    }

    this.physicsInterval = setInterval(() => {
      this.physics?.update(PHYSICS_TICK);
    }, PHYSICS_TICK);

    this.broadcastInterval = setInterval(() => {
      this.broadcastGameState();
    }, BROADCAST_TICK);

    this.timerInterval = setInterval(() => {
      this.tickTimer();
    }, 1000);

    this.io.to(this.roomKey).emit('gameStarted');
    this.broadcastRoomInfo();
    return true;
  }

  stopGame(): void {
    this.status = 'waiting';

    if (this.physicsInterval) {
      clearInterval(this.physicsInterval);
      this.physicsInterval = null;
    }
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    this.physics = null;
    this.broadcastRoomInfo();
  }

  private tickTimer(): void {
    if (this.status !== 'playing') return;
    if (this.goalCooldown) return;
    if (this.timeLeft <= 0) return;

    this.timeLeft--;

    if (this.timeLeft <= 0) {
      if (this.score.red === this.score.blue && !this.overtime) {
        this.overtime = true;
        this.timeLeft = OVERTIME_DURATION;
        this.io.to(this.roomKey).emit('overtime');
        return;
      }
      this.endByTimer();
    }
  }

  private endByTimer(): void {
    const winner: 'red' | 'blue' | null =
      this.score.red > this.score.blue ? 'red'
      : this.score.blue > this.score.red ? 'blue'
      : null;

    this.io.to(this.roomKey).emit('gameOver', {
      winner,
      score: { ...this.score },
    });

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    setTimeout(() => {
      this.reset();
    }, 4000);
  }

  // Reset the room for another match without tearing down the room itself.
  // Players keep their team assignments; score/physics/status reset to waiting.
  reset(): void {
    if (this.physicsInterval) {
      clearInterval(this.physicsInterval);
      this.physicsInterval = null;
    }
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.physics = null;
    this.status = 'waiting';
    this.score = { red: 0, blue: 0 };
    this.goalCooldown = false;
    this.timeLeft = MATCH_DURATION;
    this.overtime = false;
    this.broadcastRoomInfo();
  }

  private handleGoal(team: 'red' | 'blue'): void {
    if (this.goalCooldown) return;
    this.goalCooldown = true;

    this.score[team]++;

    this.io.to(this.roomKey).emit('goal', {
      team,
      score: { ...this.score },
    });

    if (this.score[team] >= SCORE_LIMIT) {
      this.io.to(this.roomKey).emit('gameOver', {
        winner: team,
        score: { ...this.score },
      });
      setTimeout(() => {
        this.reset();
      }, 4000);
      return;
    }

    setTimeout(() => {
      this.physics?.resetPositions();
      this.goalCooldown = false;
    }, 1500);
  }

  private broadcastGameState(): void {
    if (!this.physics || this.status !== 'playing') return;

    const snapshot = this.physics.getSnapshot();

    const playersArray = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: snapshot.players[p.id]?.x ?? 0,
      y: snapshot.players[p.id]?.y ?? 0,
      velocityX: snapshot.players[p.id]?.velocityX ?? 0,
      velocityY: snapshot.players[p.id]?.velocityY ?? 0,
      spaceClicked: snapshot.players[p.id]?.spaceClicked ?? false,
    }));

    const state: GameState = {
      ball: snapshot.ball,
      players: playersArray,
      score: { ...this.score },
      status: this.status,
      timeLeft: this.timeLeft,
      overtime: this.overtime,
    };

    this.io.to(this.roomKey).emit('gameState', state);
  }

  broadcastRoomInfo(): void {
    const info = this.getRoomInfo();
    this.io.to(this.roomKey).emit('roomUpdated', info);
  }

  getRoomInfo(): RoomInfo {
    return {
      code: this.code,
      players: Array.from(this.players.values()),
      hostId: this.hostId,
      status: this.status,
      score: { ...this.score },
    };
  }

  // Public summary for landing page match list
  getSummary() {
    const ps = Array.from(this.players.values());
    return {
      code: this.code,
      players: ps.length,
      redPlayers: ps.filter((p) => p.team === 'red').length,
      bluePlayers: ps.filter((p) => p.team === 'blue').length,
      status: this.status,
      score: { ...this.score },
    };
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }
}
