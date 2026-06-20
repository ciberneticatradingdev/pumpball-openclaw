import { Server } from 'socket.io';
import { ServerPhysics, getFieldConfig } from './physics';
import type { GameMode, FieldConfig } from './physics';

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
  avatarData?: string;
  suspended?: boolean;
};

type RoomInfo = {
  code: string;
  players: RoomPlayerData[];
  hostId: string;
  status: 'waiting' | 'playing' | 'finished';
  score: { red: number; blue: number };
  mode: GameMode;
  countdown?: number | null;
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
const SCORE_LIMIT = 5;
const MATCH_DURATION = 300;
const OVERTIME_DURATION = 60;

function getMaxTeamSize(mode: GameMode): number {
  return mode === '1v1' ? 1 : mode === '2v2' ? 2 : 4;
}

function getMaxPlayers(mode: GameMode): number {
  return getMaxTeamSize(mode) * 2;
}

export class Room {
  public code: string;
  public hostId: string;
  public persistent: boolean;
  public mode: GameMode;
  public maxTeamSize: number;
  private maxPlayers: number;
  private fieldConfig: FieldConfig;
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
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private countdownSeconds = 0;
  private rematchReady: Set<string> = new Set();
  private rematchTimeout: ReturnType<typeof setTimeout> | null = null;
  private awaitingRematch = false;

  private onGameOver?: (
    code: string,
    winner: 'red' | 'blue',
    score: { red: number; blue: number },
    players: Array<{ id: string; name: string; team: Team }>,
  ) => void;

  constructor(
    code: string,
    hostId: string,
    hostName: string,
    io: Server,
    options: {
      persistent?: boolean;
      mode?: GameMode;
      onGameOver?: (
        code: string,
        winner: 'red' | 'blue',
        score: { red: number; blue: number },
        players: Array<{ id: string; name: string; team: Team }>,
      ) => void;
    } = {},
  ) {
    this.code = code;
    this.hostId = hostId;
    this.io = io;
    this.persistent = !!options.persistent;
    this.mode = options.mode || '4v4';
    this.maxTeamSize = getMaxTeamSize(this.mode);
    this.maxPlayers = getMaxPlayers(this.mode);
    this.fieldConfig = getFieldConfig(this.mode);
    this.onGameOver = options.onGameOver;
    if (hostId) {
      this.players.set(hostId, { id: hostId, name: hostName, team: 'spectator' });
      this.autoAssignTeam(hostId);
    }
  }

  get roomKey() {
    return `room:${this.code}`;
  }

  addPlayer(id: string, name: string, avatarData?: string, options?: { spectatorOnly?: boolean }): boolean {
    this.players.set(id, { id, name, team: 'spectator', avatarData });
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = id;
    }
    if (this.status === 'waiting' && !options?.spectatorOnly) {
      this.autoAssignTeam(id);
    }
    this.broadcastRoomInfo();
    this.checkAutoStart();
    return true;
  }

  removePlayer(id: string): void {
    const player = this.players.get(id);
    const wasOnTeam = player?.team !== 'spectator';
    const playerName = player?.name ?? '';
    this.rematchReady.delete(id);
    this.players.delete(id);

    // If awaiting rematch and a team player left, cancel rematch for everyone
    if (this.awaitingRematch && wasOnTeam) {
      this.cancelRematch();
    }

    if (id === this.hostId) {
      const next = this.players.keys().next().value as string | undefined;
      if (next) {
        this.hostId = next;
      } else if (this.persistent) {
        this.hostId = '';
        if (this.status === 'playing') this.reset();
        else {
          this.cancelCountdown();
          this.broadcastRoomInfo();
        }
        return;
      } else {
        this.stopGame();
        return;
      }
    }

    if (this.status === 'playing') {
      this.physics?.removePlayer(id);

      if (wasOnTeam) {
        this.io.to(this.roomKey).emit('playerDisconnected', { name: playerName });

        const redCount = Array.from(this.players.values()).filter(p => p.team === 'red').length;
        const blueCount = Array.from(this.players.values()).filter(p => p.team === 'blue').length;

        if (redCount === 0 || blueCount === 0) {
          const winner: 'red' | 'blue' | null =
            redCount === 0 && blueCount > 0 ? 'blue' :
            blueCount === 0 && redCount > 0 ? 'red' : null;

          this.io.to(this.roomKey).emit('gameOver', {
            winner,
            score: { ...this.score },
            forfeit: true,
          });

          if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
          }

          this.broadcastRoomInfo();
          setTimeout(() => this.reset(), 4000);
          return;
        }
      }
    }

    if (wasOnTeam) {
      this.checkAutoStart();
    }

    this.broadcastRoomInfo();
  }

  // Suspend a player on disconnect — keep their slot, zero their input
  suspendPlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    player.suspended = true;
    this.physics?.updateKeyboard(id, {
      rightClicked: false,
      leftClicked: false,
      upClicked: false,
      downClicked: false,
      spaceClicked: false,
    });
  }

  // Restore a reconnected player: remap old socket ID to new socket ID
  restorePlayer(oldId: string, newId: string): RoomInfo | null {
    const player = this.players.get(oldId);
    if (!player) return null;
    player.id = newId;
    player.suspended = false;
    this.players.delete(oldId);
    this.players.set(newId, player);
    if (this.hostId === oldId) this.hostId = newId;
    this.physics?.restorePlayer(oldId, newId);
    this.broadcastRoomInfo();
    return this.getRoomInfo();
  }

  changeTeam(id: string, team: Team): void {
    const player = this.players.get(id);
    if (!player) return;

    // Mid-game: spectators CAN join a team if it has open slots
    if (this.status === 'playing' && team !== 'spectator') {
      if (player.team !== 'spectator') return; // already on a team, can't switch mid-game
      const teamCount = Array.from(this.players.values()).filter(
        (p) => p.team === team && p.id !== id,
      ).length;
      if (teamCount >= this.maxTeamSize) return;
      player.team = team;
      // Add to physics at a spawn position
      if (this.physics) {
        const idx = Array.from(this.players.values()).filter(p => p.team === team && p.id !== id).length;
        this.physics.addPlayer(id, team as 'red' | 'blue', idx);
      }
      this.io.to(this.roomKey).emit('playerJoinedMidGame', { id, name: player.name, team });
      this.broadcastRoomInfo();
      return;
    }

    if (this.status === 'playing' && team === 'spectator') {
      // Allow leaving team to spectator mid-game
      if (player.team !== 'spectator') {
        this.physics?.removePlayer(id);
      }
      player.team = team;
      this.broadcastRoomInfo();
      return;
    }

    if (team !== 'spectator') {
      const teamCount = Array.from(this.players.values()).filter(
        (p) => p.team === team && p.id !== id,
      ).length;
      if (teamCount >= this.maxTeamSize) return;
    }

    player.team = team;
    this.broadcastRoomInfo();
    this.checkAutoStart();
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

    this.physics = new ServerPhysics(this.fieldConfig, (team) => this.handleGoal(team));

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
    this.cancelCountdown();
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

    if (winner) {
      this.onGameOver?.(
        this.code,
        winner,
        { ...this.score },
        Array.from(this.players.values()).map(p => ({ id: p.id, name: p.name, team: p.team })),
      );
    }

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
    this.cancelCountdown();
    this.physics = null;
    this.status = 'waiting';
    this.score = { red: 0, blue: 0 };
    this.goalCooldown = false;
    this.timeLeft = MATCH_DURATION;
    this.overtime = false;

    // Check if enough players on teams for a rematch
    const activePlayers = this.getActivePlayers();
    const hasEnoughForRematch = activePlayers.length >= 2;

    if (hasEnoughForRematch) {
      // Start rematch phase — wait for explicit acceptance
      this.rematchReady.clear();
      this.awaitingRematch = true;
      this.io.to(this.roomKey).emit('gameReset', { canRematch: true });
      this.broadcastRoomInfo();

      // Timeout: if not everyone accepts in 20s, kick all to lobby
      if (this.rematchTimeout) clearTimeout(this.rematchTimeout);
      this.rematchTimeout = setTimeout(() => {
        if (this.awaitingRematch) {
          this.cancelRematch();
        }
      }, 20000);
    } else {
      // Not enough players (forfeit, everyone left) — no rematch, just reset
      this.awaitingRematch = false;
      this.io.to(this.roomKey).emit('gameReset', { canRematch: false });
      this.broadcastRoomInfo();
    }
  }

  private handleGoal(team: 'red' | 'blue'): void {
    if (this.goalCooldown) return;
    this.goalCooldown = true;

    this.score[team]++;

    const scorerId = this.physics?.getLastTouchPlayerId() ?? null;
    const scorer = scorerId ? this.players.get(scorerId) : null;

    this.io.to(this.roomKey).emit('goal', {
      team,
      score: { ...this.score },
      scorerId: scorer?.id,
      scorerName: scorer?.name,
    });

    if (this.score[team] >= SCORE_LIMIT) {
      this.io.to(this.roomKey).emit('gameOver', {
        winner: team,
        score: { ...this.score },
      });
      this.onGameOver?.(
        this.code,
        team,
        { ...this.score },
        Array.from(this.players.values()).map(p => ({ id: p.id, name: p.name, team: p.team })),
      );
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

  // Player accepts rematch
  acceptRematch(id: string): void {
    if (!this.awaitingRematch) return;
    const player = this.players.get(id);
    if (!player || player.team === 'spectator') return;

    this.rematchReady.add(id);
    this.io.to(this.roomKey).emit('rematchStatus', {
      accepted: Array.from(this.rematchReady),
      needed: this.getActivePlayers().length,
    });

    // Check if all active (non-spectator) players accepted
    const activePlayers = this.getActivePlayers();
    const allReady = activePlayers.every(p => this.rematchReady.has(p.id));
    if (allReady && activePlayers.length >= 2) {
      this.awaitingRematch = false;
      if (this.rematchTimeout) { clearTimeout(this.rematchTimeout); this.rematchTimeout = null; }
      this.rematchReady.clear();
      this.checkAutoStart();
    }
  }

  // Cancel rematch — dissolve the room for non-persistent, reset teams for persistent
  cancelRematch(): void {
    this.awaitingRematch = false;
    if (this.rematchTimeout) { clearTimeout(this.rematchTimeout); this.rematchTimeout = null; }
    this.rematchReady.clear();
    this.io.to(this.roomKey).emit('rematchExpired');

    // Move all players to spectator so they don't auto-start
    for (const player of this.players.values()) {
      player.team = 'spectator';
    }
    this.broadcastRoomInfo();
  }

  // Player declines rematch — triggers cancel for everyone
  declineRematch(id: string): void {
    if (!this.awaitingRematch) return;
    this.cancelRematch();
  }

  isAwaitingRematch(): boolean {
    return this.awaitingRematch;
  }

  private getActivePlayers(): RoomPlayerData[] {
    return Array.from(this.players.values()).filter(p => p.team !== 'spectator');
  }

  private autoAssignTeam(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    const redCount = Array.from(this.players.values()).filter(p => p.team === 'red' && p.id !== id).length;
    const blueCount = Array.from(this.players.values()).filter(p => p.team === 'blue' && p.id !== id).length;
    if (redCount < this.maxTeamSize && redCount <= blueCount) {
      player.team = 'red';
    } else if (blueCount < this.maxTeamSize) {
      player.team = 'blue';
    }
    // else stays spectator (both teams full)
  }

  private checkAutoStart(): void {
    if (this.status !== 'waiting') return;
    const redCount = Array.from(this.players.values()).filter(p => p.team === 'red').length;
    const blueCount = Array.from(this.players.values()).filter(p => p.team === 'blue').length;
    if (redCount === this.maxTeamSize && blueCount === this.maxTeamSize) {
      if (!this.countdownInterval) {
        this.startCountdown();
      }
    } else {
      this.cancelCountdown();
    }
  }

  private startCountdown(): void {
    this.countdownSeconds = 5;
    this.io.to(this.roomKey).emit('countdown', { seconds: this.countdownSeconds });
    this.countdownInterval = setInterval(() => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0) {
        clearInterval(this.countdownInterval!);
        this.countdownInterval = null;
        this.startGame();
      } else {
        this.io.to(this.roomKey).emit('countdown', { seconds: this.countdownSeconds });
      }
    }, 1000);
  }

  private cancelCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
      this.countdownSeconds = 0;
      this.io.to(this.roomKey).emit('countdownCancelled');
    }
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
      mode: this.mode,
      countdown: this.countdownInterval ? this.countdownSeconds : null,
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
      mode: this.mode,
      maxPlayers: this.maxPlayers,
    };
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  isFull(): boolean {
    // Only counts non-spectator players; spectators are unlimited
    const nonSpectators = Array.from(this.players.values()).filter(p => p.team !== 'spectator').length;
    return nonSpectators >= this.maxPlayers;
  }

  getPlayerAvatars(): Array<{ id: string; avatarData: string }> {
    const result: Array<{ id: string; avatarData: string }> = [];
    for (const p of this.players.values()) {
      if (p.avatarData) result.push({ id: p.id, avatarData: p.avatarData });
    }
    return result;
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }
}
