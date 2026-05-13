// PumpBall Server Physics — Based on Futsal x3 Liga de Primera (Chile) map
// Coordinate system: center-origin (0,0 = center of field), like original Haxball

// === MAP DIMENSIONS ===
const MAP_W = 620;  // half-width (total 1240)
const MAP_H = 300;  // half-height (total 600)
const FIELD_W = 550; // inner field half-width
const FIELD_H = 240; // inner field half-height

// === BALL (from disc0 in map) ===
const BALL_RADIUS = 6.4;
const BALL_INV_MASS = 1.5;
const BALL_BCOEF = 0.4;
const BALL_DAMPING = 0.99;

// === PLAYER (from playerPhysics in map) ===
const PLAYER_RADIUS = 15;
const PLAYER_INV_MASS = 0.5;
const PLAYER_BCOEF = 0;
const PLAYER_DAMPING = 0.96;
const PLAYER_ACCELERATION = 0.11;
const PLAYER_KICKING_ACCELERATION = 0.083;
const KICK_STRENGTH = 5;

// === GOALS ===
const GOAL_LINE_X = 558.95; // where goal is scored
const GOAL_Y = 80;          // goal opening: -80 to +80
const GOAL_POST_X = 550;
const GOAL_POST_RADIUS = 5;
const GOAL_NET_X = 590;     // back of the net

// === WALLS ===
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

// Spawn positions from map (center-origin)
const TEAM_POSITIONS = {
  red: [
    { x: -250, y: -50 },
    { x: -250, y: 0 },
    { x: -250, y: 50 },
  ],
  blue: [
    { x: 250, y: -50 },
    { x: 250, y: 0 },
    { x: 250, y: 50 },
  ],
};

// Static goal posts (immovable discs)
const GOAL_POSTS: Disc[] = [
  { x: -GOAL_POST_X, y: -GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
  { x: -GOAL_POST_X, y: GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
  { x: GOAL_POST_X, y: -GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
  { x: GOAL_POST_X, y: GOAL_Y, xspeed: 0, yspeed: 0, radius: GOAL_POST_RADIUS, invMass: 0, damping: 1, bCoef: 0.5 },
];

function normalise(v: [number, number]): [number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len === 0) return [0, 0];
  return [v[0] / len, v[1] / len];
}

export class ServerPhysics {
  private ball: Disc;
  private players: Map<string, PlayerData> = new Map();
  private onGoal: (team: 'red' | 'blue') => void;

  constructor(onGoal: (team: 'red' | 'blue') => void) {
    this.onGoal = onGoal;

    this.ball = {
      x: 0, y: 0,
      xspeed: 0, yspeed: 0,
      radius: BALL_RADIUS,
      invMass: BALL_INV_MASS,
      damping: BALL_DAMPING,
      bCoef: BALL_BCOEF,
    };
  }

  addPlayer(id: string, team: 'red' | 'blue', index: number): void {
    if (this.players.has(id)) return;
    const positions = TEAM_POSITIONS[team];
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
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  updateKeyboard(id: string, keyboard: Keyboard): void {
    const player = this.players.get(id);
    if (player) player.keyboard = keyboard;
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

    // 3. Damping
    this.applyDamping(this.ball);
    for (const player of this.players.values()) {
      this.applyDamping(player.disc);
    }

    // 4. Disc-disc collisions (players + ball)
    const allMovable = [this.ball, ...Array.from(this.players.values()).map(p => p.disc)];
    for (let i = 0; i < allMovable.length; i++) {
      for (let j = i + 1; j < allMovable.length; j++) {
        this.resolveDiscCollision(allMovable[i], allMovable[j]);
      }
    }

    // 5. Goal post collisions (ball and players vs static posts)
    for (const post of GOAL_POSTS) {
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

    let dx = 0, dy = 0;
    if (keyboard.leftClicked) dx--;
    if (keyboard.rightClicked) dx++;
    if (keyboard.upClicked) dy--;
    if (keyboard.downClicked) dy++;

    const dir = normalise([dx, dy]);
    const accel = isKicking ? PLAYER_KICKING_ACCELERATION : PLAYER_ACCELERATION;

    disc.xspeed += dir[0] * accel;
    disc.yspeed += dir[1] * accel;

    // Kick ball
    if (isKicking) {
      const distX = this.ball.x - disc.x;
      const distY = this.ball.y - disc.y;
      const dist = Math.sqrt(distX * distX + distY * distY);
      const kickRange = disc.radius + this.ball.radius + 4;

      if (dist > 0 && dist <= kickRange) {
        const n = [distX / dist, distY / dist];
        this.ball.xspeed += n[0] * KICK_STRENGTH;
        this.ball.yspeed += n[1] * KICK_STRENGTH;
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

  private resolveDiscCollision(a: Disc, b: Disc): void {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radiusSum = a.radius + b.radius;

    if (dist <= 0 || dist > radiusSum) return;

    const normal = [dx / dist, dy / dist];
    const totalInvMass = a.invMass + b.invMass;
    if (totalInvMass === 0) return;

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
  }

  private handleWalls(): void {
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
      const positions = TEAM_POSITIONS[player.team];
      const pos = positions[idx] ?? positions[0];
      player.disc.x = pos.x; player.disc.y = pos.y;
      player.disc.xspeed = 0; player.disc.yspeed = 0;
      player.keyboard = { ...initialKeyboard };
    }
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
