// PumpBall Server Physics — Haxball-faithful custom engine (no Matter.js)
// Based on the original Haxball physics: position += speed, speed *= damping, custom collisions

const FIELD_WIDTH = 1000;
const FIELD_HEIGHT = 550;
const BORDER = 30; // Inner field offset, matches renderer

// Original Haxball values (Classic map scaled to our field)
const PLAYER_RADIUS = 15;
const BALL_RADIUS = 10;
const GOAL_OFFSET = 80;

// Player physics (from original Haxball)
const PLAYER_DAMPING = 0.96;
const PLAYER_ACCELERATION = 0.1;
const PLAYER_KICKING_ACCELERATION = 0.07;
const PLAYER_KICKING_DAMPING = 0.96;
const PLAYER_INV_MASS = 0.5;
const PLAYER_BCOEF = 0.5;
const KICK_STRENGTH = 5;

// Ball physics (from original Haxball)
const BALL_DAMPING = 0.99;
const BALL_INV_MASS = 1;
const BALL_BCOEF = 0.5;

// Wall bCoef
const WALL_BCOEF = 1;

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

const TEAM_POSITIONS = {
  red: [
    { x: BORDER + 110, y: FIELD_HEIGHT * 0.3 },
    { x: BORDER + 110, y: FIELD_HEIGHT * 0.5 },
    { x: BORDER + 110, y: FIELD_HEIGHT * 0.7 },
  ],
  blue: [
    { x: FIELD_WIDTH - BORDER - 110, y: FIELD_HEIGHT * 0.3 },
    { x: FIELD_WIDTH - BORDER - 110, y: FIELD_HEIGHT * 0.5 },
    { x: FIELD_WIDTH - BORDER - 110, y: FIELD_HEIGHT * 0.7 },
  ],
};

// Field boundaries (inner playfield)
const FIELD_MIN_X = BORDER;
const FIELD_MAX_X = FIELD_WIDTH - BORDER;
const FIELD_MIN_Y = BORDER;
const FIELD_MAX_Y = FIELD_HEIGHT - BORDER;

// Goal zone Y range
const GOAL_Y_TOP = FIELD_HEIGHT / 3;
const GOAL_Y_BOT = (FIELD_HEIGHT * 2) / 3;

// Goal line X positions (where goals are scored — at the field edge)
const GOAL_LINE_LEFT = BORDER;
const GOAL_LINE_RIGHT = FIELD_WIDTH - BORDER;

function normalise(v: [number, number]): [number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len === 0) return [0, 0];
  return [v[0] / len, v[1] / len];
}

export class ServerPhysics {
  private ball: Disc;
  private players: Map<string, PlayerData> = new Map();
  private onGoal: (team: 'red' | 'blue') => void;
  private prevBallX: number;

  constructor(onGoal: (team: 'red' | 'blue') => void) {
    this.onGoal = onGoal;

    this.ball = {
      x: FIELD_WIDTH / 2,
      y: FIELD_HEIGHT / 2,
      xspeed: 0,
      yspeed: 0,
      radius: BALL_RADIUS,
      invMass: BALL_INV_MASS,
      damping: BALL_DAMPING,
      bCoef: BALL_BCOEF,
    };

    this.prevBallX = this.ball.x;
  }

  addPlayer(id: string, team: 'red' | 'blue', index: number): void {
    if (this.players.has(id)) return;

    const positions = TEAM_POSITIONS[team];
    const pos = positions[index] ?? positions[0];

    const disc: Disc = {
      x: pos.x,
      y: pos.y,
      xspeed: 0,
      yspeed: 0,
      radius: PLAYER_RADIUS,
      invMass: PLAYER_INV_MASS,
      damping: PLAYER_DAMPING,
      bCoef: PLAYER_BCOEF,
    };

    this.players.set(id, {
      disc,
      id,
      team,
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
    this.prevBallX = this.ball.x;

    // 1. Apply player movement (like original Haxball)
    for (const player of this.players.values()) {
      this.applyPlayerMovement(player);
    }

    // 2. Move all discs: position += speed
    this.moveDisc(this.ball);
    for (const player of this.players.values()) {
      this.moveDisc(player.disc);
    }

    // 3. Apply damping: speed *= damping
    this.applyDamping(this.ball);
    for (const player of this.players.values()) {
      this.applyDamping(player.disc);
    }

    // 4. Resolve disc-disc collisions
    const allDiscs = [this.ball, ...Array.from(this.players.values()).map(p => p.disc)];
    for (let i = 0; i < allDiscs.length; i++) {
      for (let j = i + 1; j < allDiscs.length; j++) {
        this.resolveDiscCollision(allDiscs[i], allDiscs[j]);
      }
    }

    // 5. Handle wall boundaries
    this.handleWalls();

    // 6. Check goals
    this.checkGoals();
  }

  private applyPlayerMovement(player: PlayerData): void {
    const { keyboard, disc } = player;
    const isKicking = keyboard.spaceClicked;

    let dx = 0;
    let dy = 0;
    if (keyboard.leftClicked) dx--;
    if (keyboard.rightClicked) dx++;
    if (keyboard.upClicked) dy--;
    if (keyboard.downClicked) dy++;

    const dir = normalise([dx, dy]);
    const accel = isKicking ? PLAYER_KICKING_ACCELERATION : PLAYER_ACCELERATION;

    disc.xspeed += dir[0] * accel;
    disc.yspeed += dir[1] * accel;

    // Kick: apply force to ball if close enough
    if (isKicking) {
      const distX = this.ball.x - disc.x;
      const distY = this.ball.y - disc.y;
      const dist = Math.sqrt(distX * distX + distY * distY);
      const kickRange = disc.radius + this.ball.radius + 4;

      if (dist > 0 && dist <= kickRange) {
        const normal = [distX / dist, distY / dist];
        this.ball.xspeed += normal[0] * KICK_STRENGTH;
        this.ball.yspeed += normal[1] * KICK_STRENGTH;
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
    const massFactor = a.invMass / (a.invMass + b.invMass);

    // Separate overlapping discs
    const overlap = radiusSum - dist;
    a.x += normal[0] * overlap * massFactor;
    a.y += normal[1] * overlap * massFactor;
    b.x -= normal[0] * overlap * (1 - massFactor);
    b.y -= normal[1] * overlap * (1 - massFactor);

    // Velocity response (original Haxball formula)
    const relVelX = a.xspeed - b.xspeed;
    const relVelY = a.yspeed - b.yspeed;
    const normalVel = relVelX * normal[0] + relVelY * normal[1];

    if (normalVel < 0) {
      const speedFactor = normalVel * (a.bCoef * b.bCoef + 1);

      a.xspeed -= normal[0] * speedFactor * massFactor;
      a.yspeed -= normal[1] * speedFactor * massFactor;
      b.xspeed += normal[0] * speedFactor * (1 - massFactor);
      b.yspeed += normal[1] * speedFactor * (1 - massFactor);
    }
  }

  private handleWalls(): void {
    // Ball walls
    this.bounceDiscOffWalls(this.ball, true);

    // Player walls
    for (const player of this.players.values()) {
      this.bounceDiscOffWalls(player.disc, false);
    }
  }

  private bounceDiscOffWalls(disc: Disc, isBall: boolean): void {
    const minX = FIELD_MIN_X + disc.radius;
    const maxX = FIELD_MAX_X - disc.radius;
    const minY = FIELD_MIN_Y + disc.radius;
    const maxY = FIELD_MAX_Y - disc.radius;

    const inGoalZone = disc.y > GOAL_Y_TOP && disc.y < GOAL_Y_BOT;

    // Left wall
    if (disc.x < minX) {
      if (!isBall || !inGoalZone) {
        disc.x = minX;
        disc.xspeed = isBall ? Math.abs(disc.xspeed) * WALL_BCOEF : 0;
      }
    }
    // Right wall
    if (disc.x > maxX) {
      if (!isBall || !inGoalZone) {
        disc.x = maxX;
        disc.xspeed = isBall ? -Math.abs(disc.xspeed) * WALL_BCOEF : 0;
      }
    }
    // Top wall
    if (disc.y < minY) {
      disc.y = minY;
      disc.yspeed = isBall ? Math.abs(disc.yspeed) * WALL_BCOEF : 0;
    }
    // Bottom wall
    if (disc.y > maxY) {
      disc.y = maxY;
      disc.yspeed = isBall ? -Math.abs(disc.yspeed) * WALL_BCOEF : 0;
    }
  }

  private checkGoals(): void {
    const ball = this.ball;
    const inGoalY = ball.y > GOAL_Y_TOP && ball.y < GOAL_Y_BOT;

    if (!inGoalY) return;

    // Ball crossed left goal line → blue scores
    if (ball.x < GOAL_LINE_LEFT) {
      this.onGoal('blue');
      return;
    }

    // Ball crossed right goal line → red scores
    if (ball.x > GOAL_LINE_RIGHT) {
      this.onGoal('red');
      return;
    }
  }

  resetPositions(): void {
    this.ball.x = FIELD_WIDTH / 2;
    this.ball.y = FIELD_HEIGHT / 2;
    this.ball.xspeed = 0;
    this.ball.yspeed = 0;
    this.prevBallX = this.ball.x;

    let redIndex = 0;
    let blueIndex = 0;

    for (const player of this.players.values()) {
      const index = player.team === 'red' ? redIndex++ : blueIndex++;
      const positions = TEAM_POSITIONS[player.team];
      const pos = positions[index] ?? positions[0];

      player.disc.x = pos.x;
      player.disc.y = pos.y;
      player.disc.xspeed = 0;
      player.disc.yspeed = 0;
      player.keyboard = { ...initialKeyboard };
    }
  }

  getSnapshot(): PhysicsSnapshot {
    const players: PhysicsSnapshot['players'] = {};

    for (const [id, player] of this.players.entries()) {
      players[id] = {
        x: player.disc.x,
        y: player.disc.y,
        velocityX: player.disc.xspeed,
        velocityY: player.disc.yspeed,
        spaceClicked: player.keyboard.spaceClicked,
      };
    }

    return {
      ball: {
        x: this.ball.x,
        y: this.ball.y,
        velocityX: this.ball.xspeed,
        velocityY: this.ball.yspeed,
      },
      players,
    };
  }
}
