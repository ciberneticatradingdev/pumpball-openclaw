// PumpBall Server Physics — Based on Futsal x3 Liga de Primera (Chile) map
// Coordinate system: center-origin (0,0 = center of field), like original Haxball

// === FIELD CONFIG ===
export type GameMode = '1v1' | '2v2' | '4v4';

export interface FieldConfig {
  mode: GameMode;
  FIELD_W: number;
  FIELD_H: number;
  MAP_W: number;
  MAP_H: number;
  GOAL_Y: number;
  GOAL_POST_X: number;
  GOAL_NET_X: number;
  GOAL_LINE_X: number;
}

const FIELD_CONFIGS: Record<GameMode, FieldConfig> = {
  '4v4': {
    mode: '4v4',
    FIELD_W: 550, FIELD_H: 240, MAP_W: 620, MAP_H: 300,
    GOAL_Y: 80, GOAL_POST_X: 550, GOAL_NET_X: 590, GOAL_LINE_X: 558.95,
  },
  '2v2': {
    mode: '2v2',
    FIELD_W: 440, FIELD_H: 192, MAP_W: 496, MAP_H: 240,
    GOAL_Y: 64, GOAL_POST_X: 440, GOAL_NET_X: 472, GOAL_LINE_X: 447.16,
  },
  '1v1': {
    mode: '1v1',
    FIELD_W: 330, FIELD_H: 144, MAP_W: 372, MAP_H: 180,
    GOAL_Y: 48, GOAL_POST_X: 330, GOAL_NET_X: 354, GOAL_LINE_X: 335.37,
  },
};

export function getFieldConfig(mode: GameMode): FieldConfig {
  return FIELD_CONFIGS[mode];
}

// === BALL (from disc0 in map) ===
const BALL_RADIUS = 6.4;
const BALL_INV_MASS = 1.5;
const BALL_BCOEF = 0.4;
const BALL_DAMPING = 0.985;

// === PLAYER (from playerPhysics in map) ===
const PLAYER_RADIUS = 15;
const PLAYER_INV_MASS = 0.5;
const PLAYER_BCOEF = 0;
const PLAYER_DAMPING = 0.92;
const PLAYER_ACCELERATION = 0.16;
const PLAYER_KICKING_ACCELERATION = 0.12;
const PLAYER_KICKING_DAMPING = 0.92;
const KICK_STRENGTH = 5.2;

// === WALLS ===
const GOAL_POST_RADIUS = 5;
const WALL_BCOEF = 1; // ball area walls
const OUTER_BCOEF = 0.1; // outer walls

type Team = 'red' | 'blue' | 'spectator';

type Keyboard = {
  rightClicked: boolean;
  leftClicked: boolean;
  upClicked: boolean;
  downClicked: boolean;
  spaceClicked: boolean;
};

const initialKeyboard: Keyboard = {
  rightClicked: false,
  leftClicked: false,
  upClicked: false,
  downClicked: false,
  spaceClicked: false,
};

type Disc = {
  x: number;
  y: number;
  xspeed: number;
  yspeed: number;
  radius: number;
  invMass: number;
  damping: number;
  bCoef: number;
};

type PlayerData = {
  disc: Disc;
  id: string;
  team: 'red' | 'blue';
  keyboard: Keyboard;
  kickFired: boolean; // true after kick impulse applied, resets on key release
};

export type PhysicsSnapshot = {
  ball: { x: number; y: number; velocityX: number; velocityY: number };
  players: Record<string, {
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    spaceClicked: boolean;
  }>;
};

// Base 4v4 spawn positions (center-origin)
const BASE_POSITIONS = {
  red: [
    { x: -250, y: -75 },
    { x: -250, y: -25 },
    { x: -250, y: 25 },
    { x: -250, y: 75 },
  ],
  blue: [
    { x: 250, y: -75 },
    { x: 250, y: -25 },
    { x: 250, y: 25 },
    { x: 250, y: 75 },
  ],
};

function getTeamPositions(mode: GameMode): { red: Array<{ x: number; y: number }>; blue: Array<{ x: number; y: number }> } {
  const scale = mode === '1v1' ? 0.6 : mode === '2v2' ? 0.8 : 1;
  const maxPerTeam = mode === '1v1' ? 1 : mode === '2v2' ? 2 : 4;
  const red = BASE_POSITIONS.red.slice(0, maxPerTeam).map(p => ({ x: p.x * scale, y: p.y * scale }));
  const blue = BASE_POSITIONS.blue.slice(0, maxPerTeam).map(p => ({ x: p.x * scale, y: p.y * scale }));
  return { red, blue };
}

function normalise(v: [number, number]): [number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len === 0) return [0, 0];
  return [v[0] / len, v[1] / len];
}

export class ServerPhysics {
  private ball: Disc;
  private players: Map<string, PlayerData> = new Map();
  private onGoal: (team: 'red' | 'blue') => void;
  private config: FieldConfig;
  private goalPosts: Disc[];
  private teamPositions: { red: Array<{ x: number; y: number }>; blue: Array<{ x: number; y: number }> };
  private lastTouchPlayerId: string | null = null;

  constructor(config: FieldConfig, onGoal: (team: 'red' | 'blue') => void) {
    this.config = config;
    this.onGoal = onGoal;
    this.teamPositions = getTeamPositions(config.mode);

    this.ball = {
      x: 0, y: 0,
      xspeed: 0, yspeed: 0,
      radius: BALL_RADIUS,
      invMass: BALL_INV_MASS,
      damping: BALL_DAMPING,
      bCoef: BALL_BCOEF,
    };

    // Static goal posts (immovable discs)
    this.goalPosts = [
      { x: -config.GOAL_POST_X, y: -config.GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
      { x: -config.GOAL_POST_X, y: config.GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
      { x: config.GOAL_POST_X, y: -config.GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
      { x: config.GOAL_POST_X, y: config.GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
    ];
  }

  addPlayer(id: string, team: 'red' | 'blue', index: number): void {
    if (this.players.has(id)) return;
    const positions = this.teamPositions[team];
    const pos = positions[index] ?? positions[0];

    this.players.set(id, {
      disc: {
        x: pos.x, y: pos.y,
        xspeed: 0, yspeed: 0,
        radius: PLAYER_RADIUS,
        invMass: PLAYER_INV_MASS,
        damping: PLAYER_DAMPING,
        bCoef: PLAYER_BCOEF,
      },
      id, team,
      keyboard: { ...initialKeyboard },
      kickFired: false,
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  updateKeyboard(id: string, keyboard: Keyboard): void {
    const player = this.players.get(id);
    if (player) player.keyboard = keyboard;
  }

  // Rename a player's ID in physics state (used for reconnection)
  restorePlayer(oldId: string, newId: string): void {
    const player = this.players.get(oldId);
    if (!player) return;
    player.id = newId;
    this.players.delete(oldId);
    this.players.set(newId, player);
  }

  update(_delta: number): void {
    // 1. Player movement
    for (const player of this.players.values()) {
      this.applyPlayerMovement(player);
    }

    // 2. Move discs
    this.moveDisc(this.ball);
    for (const player of this.players.values()) {
      this.moveDisc(player.disc);
    }

    // 3. Damping (use kickingDamping when kicking)
    this.applyDamping(this.ball);
    for (const player of this.players.values()) {
      const d = player.disc;
      const damping = player.keyboard.spaceClicked ? PLAYER_KICKING_DAMPING : PLAYER_DAMPING;
      d.xspeed *= damping;
      d.yspeed *= damping;
    }

    // 4. Disc-disc collisions — ball vs players (tracked for scorer), then player vs player
    for (const player of this.players.values()) {
      if (this.resolveDiscCollision(player.disc, this.ball)) {
        this.lastTouchPlayerId = player.id;
      }
    }
    const playerArray = Array.from(this.players.values());
    for (let i = 0; i < playerArray.length; i++) {
      for (let j = i + 1; j < playerArray.length; j++) {
        this.resolveDiscCollision(playerArray[i].disc, playerArray[j].disc);
      }
    }

    // 5. Goal post collisions (ball and players vs static posts)
    for (const post of this.goalPosts) {
      this.resolveDiscCollision(this.ball, post);
      for (const player of this.players.values()) {
        this.resolveDiscCollision(player.disc, post);
      }
    }

    // 6. Walls
    this.handleWalls();

    // 7. Goals
    this.checkGoals();
  }

  private applyPlayerMovement(player: PlayerData): void {
    const { keyboard, disc } = player;
    const isKicking = keyboard.spaceClicked;

    // Reset kick state when key released
    if (!isKicking) {
      player.kickFired = false;
    }

    let dx = 0, dy = 0;
    if (keyboard.leftClicked) dx--;
    if (keyboard.rightClicked) dx++;
    if (keyboard.upClicked) dy--;
    if (keyboard.downClicked) dy++;

    const dir = normalise([dx, dy]);
    const accel = isKicking ? PLAYER_KICKING_ACCELERATION : PLAYER_ACCELERATION;

    disc.xspeed += dir[0] * accel;
    disc.yspeed += dir[1] * accel;

    // Kick: ONE-SHOT impulse (only on first press, not continuous)
    if (isKicking && !player.kickFired) {
      const distX = this.ball.x - disc.x;
      const distY = this.ball.y - disc.y;
      const dist = Math.sqrt(distX * distX + distY * distY);
      const kickRange = disc.radius + this.ball.radius + 4;

      if (dist > 0 && dist <= kickRange) {
        const n = [distX / dist, distY / dist];
        this.ball.xspeed += n[0] * KICK_STRENGTH;
        this.ball.yspeed += n[1] * KICK_STRENGTH;
        player.kickFired = true;
        this.lastTouchPlayerId = player.id;
      }
    }
  }

  private moveDisc(disc: Disc): void {
    disc.x += disc.xspeed;
    disc.y += disc.yspeed;
  }

  private applyDamping(disc: Disc): void {
    disc.xspeed *= disc.damping;
    disc.yspeed *= disc.damping;
  }

  private resolveDiscCollision(a: Disc, b: Disc): boolean {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radiusSum = a.radius + b.radius;

    if (dist <= 0 || dist > radiusSum) return false;

    const normal = [dx / dist, dy / dist];
    const totalInvMass = a.invMass + b.invMass;
    if (totalInvMass === 0) return false;

    const massFactorA = a.invMass / totalInvMass;
    const massFactorB = b.invMass / totalInvMass;

    // Separate
    const overlap = radiusSum - dist;
    a.x += normal[0] * overlap * massFactorA;
    a.y += normal[1] * overlap * massFactorA;
    b.x -= normal[0] * overlap * massFactorB;
    b.y -= normal[1] * overlap * massFactorB;

    // Velocity response
    const relVelX = a.xspeed - b.xspeed;
    const relVelY = a.yspeed - b.yspeed;
    const normalVel = relVelX * normal[0] + relVelY * normal[1];

    if (normalVel < 0) {
      const speedFactor = normalVel * (a.bCoef * b.bCoef + 1);
      a.xspeed -= normal[0] * speedFactor * massFactorA;
      a.yspeed -= normal[1] * speedFactor * massFactorA;
      b.xspeed += normal[0] * speedFactor * massFactorB;
      b.yspeed += normal[1] * speedFactor * massFactorB;
    }

    return true;
  }

  private handleWalls(): void {
    const { FIELD_W, FIELD_H, GOAL_Y, GOAL_NET_X, MAP_W, MAP_H } = this.config;
    const ball = this.ball;
    const inGoalY = ball.y > -GOAL_Y && ball.y < GOAL_Y;

    // Ball vs field walls
    // Top/bottom: always solid at ±FIELD_H
    if (ball.y - ball.radius < -FIELD_H) {
      ball.y = -FIELD_H + ball.radius;
      ball.yspeed = Math.abs(ball.yspeed) * WALL_BCOEF;
    }
    if (ball.y + ball.radius > FIELD_H) {
      ball.y = FIELD_H - ball.radius;
      ball.yspeed = -Math.abs(ball.yspeed) * WALL_BCOEF;
    }

    // Left/right: solid except in goal zone
    if (ball.x - ball.radius < -FIELD_W && !inGoalY) {
      ball.x = -FIELD_W + ball.radius;
      ball.xspeed = Math.abs(ball.xspeed) * WALL_BCOEF;
    }
    if (ball.x + ball.radius > FIELD_W && !inGoalY) {
      ball.x = FIELD_W - ball.radius;
      ball.xspeed = -Math.abs(ball.xspeed) * WALL_BCOEF;
    }

    // Ball in goal net area: bounce off back/top/bottom of net
    if (inGoalY || (ball.x < -FIELD_W || ball.x > FIELD_W)) {
      // Left net
      if (ball.x - ball.radius < -GOAL_NET_X) {
        ball.x = -GOAL_NET_X + ball.radius;
        ball.xspeed = Math.abs(ball.xspeed) * OUTER_BCOEF;
      }
      // Right net
      if (ball.x + ball.radius > GOAL_NET_X) {
        ball.x = GOAL_NET_X - ball.radius;
        ball.xspeed = -Math.abs(ball.xspeed) * OUTER_BCOEF;
      }
      // Net top/bottom when ball is past the goal line
      if (ball.x < -FIELD_W || ball.x > FIELD_W) {
        if (ball.y - ball.radius < -GOAL_Y) {
          ball.y = -GOAL_Y + ball.radius;
          ball.yspeed = Math.abs(ball.yspeed) * OUTER_BCOEF;
        }
        if (ball.y + ball.radius > GOAL_Y) {
          ball.y = GOAL_Y - ball.radius;
          ball.yspeed = -Math.abs(ball.yspeed) * OUTER_BCOEF;
        }
      }
    }

    // Players vs outer walls (no bounce, just clamp)
    for (const player of this.players.values()) {
      const d = player.disc;
      if (d.x - d.radius < -MAP_W) { d.x = -MAP_W + d.radius; d.xspeed = 0; }
      if (d.x + d.radius > MAP_W) { d.x = MAP_W - d.radius; d.xspeed = 0; }
      if (d.y - d.radius < -MAP_H) { d.y = -MAP_H + d.radius; d.yspeed = 0; }
      if (d.y + d.radius > MAP_H) { d.y = MAP_H - d.radius; d.yspeed = 0; }
    }
  }

  private checkGoals(): void {
    const { GOAL_Y, GOAL_LINE_X } = this.config;
    const ball = this.ball;
    const inGoalY = ball.y > -GOAL_Y && ball.y < GOAL_Y;
    if (!inGoalY) return;

    if (ball.x < -GOAL_LINE_X) {
      this.onGoal('blue');
    } else if (ball.x > GOAL_LINE_X) {
      this.onGoal('red');
    }
  }

  resetPositions(): void {
    this.ball.x = 0; this.ball.y = 0;
    this.ball.xspeed = 0; this.ball.yspeed = 0;

    let redIdx = 0, blueIdx = 0;
    for (const player of this.players.values()) {
      const idx = player.team === 'red' ? redIdx++ : blueIdx++;
      const positions = this.teamPositions[player.team];
      const pos = positions[idx] ?? positions[0];
      player.disc.x = pos.x; player.disc.y = pos.y;
      player.disc.xspeed = 0; player.disc.yspeed = 0;
      player.keyboard = { ...initialKeyboard };
      player.kickFired = false;
    }
  }

  getLastTouchPlayerId(): string | null {
    return this.lastTouchPlayerId;
  }

  getSnapshot(): PhysicsSnapshot {
    const players: PhysicsSnapshot['players'] = {};
    for (const [id, player] of this.players.entries()) {
      players[id] = {
        x: player.disc.x, y: player.disc.y,
        velocityX: player.disc.xspeed, velocityY: player.disc.yspeed,
        spaceClicked: player.keyboard.spaceClicked,
      };
    }
    return {
      ball: {
        x: this.ball.x, y: this.ball.y,
        velocityX: this.ball.xspeed, velocityY: this.ball.yspeed,
      },
      players,
    };
  }
}
