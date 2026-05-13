import { Engine, Bodies, Body, Composite, Events } from 'matter-js';

// Field constants (inline to avoid module resolution issues in ts-node)
const FIELD_WIDTH = 1000;
const FIELD_HEIGHT = 550;
const PLAYER_RADIUS = 20;
const BALL_RADIUS = 10;
const GOAL_OFFSET = 80;

const COLLISION_FILTER_DEFAULT = 1;
const COLLISION_FILTER_BALL = 4;
const COLLISION_FILTER_PLAYER = 8;

const MIN_FORCE_APPLY_INTERVAL = 150;
const MOVEMENT_VELOCITY_CHANGE = 0.5;
const PLAYER_MAX_VELOCITY = 3;
const PLAYER_POWER_KICK_RADIUS = 10;
const BALL_FORCE_MULTIPLIER = 5;

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

type PlayerPhysics = {
  body: Body;
  id: string;
  team: Team;
  keyboard: Keyboard;
  lastForceApplyTime: number;
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
    { x: 150, y: 165 },
    { x: 150, y: 275 },
    { x: 150, y: 385 },
  ],
  blue: [
    { x: 850, y: 165 },
    { x: 850, y: 275 },
    { x: 850, y: 385 },
  ],
};

export class ServerPhysics {
  private engine: Engine;
  private ball: Body;
  private players: Map<string, PlayerPhysics> = new Map();
  private onGoal: (team: 'red' | 'blue') => void;

  private readonly GOAL_Y_TOP = FIELD_HEIGHT / 3;
  private readonly GOAL_Y_BOT = (FIELD_HEIGHT * 2) / 3;

  constructor(onGoal: (team: 'red' | 'blue') => void) {
    this.onGoal = onGoal;
    this.engine = Engine.create({ gravity: { x: 0, y: 0 } });

    this.ball = Bodies.circle(FIELD_WIDTH / 2, FIELD_HEIGHT / 2, BALL_RADIUS, {
      restitution: 0.9,
      collisionFilter: {
        category: COLLISION_FILTER_BALL,
        mask: COLLISION_FILTER_DEFAULT | COLLISION_FILTER_PLAYER,
      },
    });

    Composite.add(this.engine.world, this.ball);

    Events.on(this.engine, 'beforeUpdate', () => {
      this.handleBoundaryCollisions();
    });
  }

  addPlayer(id: string, team: Team, index: number): void {
    if (team === 'spectator') return;
    if (this.players.has(id)) return;

    const positions = TEAM_POSITIONS[team];
    const pos = positions[index] ?? positions[0];

    const body = Bodies.circle(pos.x, pos.y, PLAYER_RADIUS, {
      collisionFilter: {
        mask: COLLISION_FILTER_DEFAULT | COLLISION_FILTER_BALL | COLLISION_FILTER_PLAYER,
        category: COLLISION_FILTER_PLAYER,
      },
    });

    Composite.add(this.engine.world, body);
    this.players.set(id, {
      body,
      id,
      team,
      keyboard: { ...initialKeyboard },
      lastForceApplyTime: 0,
    });
  }

  removePlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    Composite.remove(this.engine.world, player.body);
    this.players.delete(id);
  }

  updateKeyboard(id: string, keyboard: Keyboard): void {
    const player = this.players.get(id);
    if (player) player.keyboard = keyboard;
  }

  update(delta: number): void {
    this.applyAllForces();
    Engine.update(this.engine, delta);
  }

  private applyAllForces(): void {
    const now = Date.now();
    for (const player of this.players.values()) {
      this.applyForces(player, now);
    }
  }

  private applyForces(player: PlayerPhysics, now: number): void {
    const { keyboard, body } = player;

    if (now - player.lastForceApplyTime > MIN_FORCE_APPLY_INTERVAL) {
      const velocity = { ...body.velocity };

      if (keyboard.leftClicked) velocity.x -= MOVEMENT_VELOCITY_CHANGE;
      if (keyboard.rightClicked) velocity.x += MOVEMENT_VELOCITY_CHANGE;
      if (keyboard.upClicked) velocity.y -= MOVEMENT_VELOCITY_CHANGE;
      if (keyboard.downClicked) velocity.y += MOVEMENT_VELOCITY_CHANGE;

      velocity.x = Math.min(Math.max(velocity.x, -PLAYER_MAX_VELOCITY), PLAYER_MAX_VELOCITY);
      velocity.y = Math.min(Math.max(velocity.y, -PLAYER_MAX_VELOCITY), PLAYER_MAX_VELOCITY);

      if (velocity.x !== 0 || velocity.y !== 0) {
        Body.setVelocity(body, velocity);
        player.lastForceApplyTime = now;
      }
    }

    if (!keyboard.spaceClicked) return;

    const bodyPos = body.position;
    const ballPos = this.ball.position;
    const dist = Math.sqrt((bodyPos.x - ballPos.x) ** 2 + (bodyPos.y - ballPos.y) ** 2);

    if (dist < PLAYER_RADIUS + BALL_RADIUS + PLAYER_POWER_KICK_RADIUS && dist > 0) {
      const dir = {
        x: (ballPos.x - bodyPos.x) / dist,
        y: (ballPos.y - bodyPos.y) / dist,
      };
      const pv = Body.getVelocity(body);
      Body.setVelocity(this.ball, {
        x: BALL_FORCE_MULTIPLIER * dir.x + pv.x,
        y: BALL_FORCE_MULTIPLIER * dir.y + pv.y,
      });
    }
  }

  private handleBoundaryCollisions(): void {
    const ballPos = this.ball.position;
    const inGoalY = ballPos.y > this.GOAL_Y_TOP && ballPos.y < this.GOAL_Y_BOT;

    // Blue goal on right side → red scores
    if (ballPos.x > FIELD_WIDTH - GOAL_OFFSET && inGoalY) {
      this.onGoal('red');
      return;
    }

    // Red goal on left side → blue scores
    if (ballPos.x < GOAL_OFFSET && inGoalY) {
      this.onGoal('blue');
      return;
    }

    // Player boundary enforcement
    for (const { body } of this.players.values()) {
      const pos = body.position;
      const maxX = FIELD_WIDTH - PLAYER_RADIUS - 2;
      const maxY = FIELD_HEIGHT - PLAYER_RADIUS - 2;
      const minX = PLAYER_RADIUS + 2;
      const minY = PLAYER_RADIUS + 2;

      if (pos.x >= maxX) {
        Body.setPosition(body, { x: maxX, y: pos.y });
        Body.setVelocity(body, { x: Math.min(body.velocity.x, -0.1), y: body.velocity.y });
      } else if (pos.x <= minX) {
        Body.setPosition(body, { x: minX, y: pos.y });
        Body.setVelocity(body, { x: Math.max(body.velocity.x, 0.1), y: body.velocity.y });
      }

      const pos2 = body.position;
      if (pos2.y >= maxY) {
        Body.setPosition(body, { x: pos2.x, y: maxY });
        Body.setVelocity(body, { x: body.velocity.x, y: Math.min(body.velocity.y, -0.1) });
      } else if (pos2.y <= minY) {
        Body.setPosition(body, { x: pos2.x, y: minY });
        Body.setVelocity(body, { x: body.velocity.x, y: Math.max(body.velocity.y, 0.1) });
      }
    }

    // Ball boundary enforcement
    const bMaxX = FIELD_WIDTH - BALL_RADIUS - 2;
    const bMaxY = FIELD_HEIGHT - BALL_RADIUS - 2;
    const bMinX = BALL_RADIUS + 2;
    const bMinY = BALL_RADIUS + 2;

    // Left wall (solid except in goal zone)
    if (ballPos.x <= bMinX && !inGoalY) {
      Body.setPosition(this.ball, { x: bMinX, y: ballPos.y });
      Body.setVelocity(this.ball, { x: Math.abs(this.ball.velocity.x) + 0.5, y: this.ball.velocity.y });
    }
    // Right wall (solid except in goal zone)
    if (ballPos.x >= bMaxX && !inGoalY) {
      Body.setPosition(this.ball, { x: bMaxX, y: ballPos.y });
      Body.setVelocity(this.ball, { x: -(Math.abs(this.ball.velocity.x) + 0.5), y: this.ball.velocity.y });
    }
    // Top/bottom walls always solid
    const bPos2 = this.ball.position;
    if (bPos2.y >= bMaxY) {
      Body.setPosition(this.ball, { x: bPos2.x, y: bMaxY });
      Body.setVelocity(this.ball, { x: this.ball.velocity.x, y: -(Math.abs(this.ball.velocity.y) + 0.5) });
    } else if (bPos2.y <= bMinY) {
      Body.setPosition(this.ball, { x: bPos2.x, y: bMinY });
      Body.setVelocity(this.ball, { x: this.ball.velocity.x, y: Math.abs(this.ball.velocity.y) + 0.5 });
    }
  }

  resetPositions(): void {
    Body.setPosition(this.ball, { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 });
    Body.setVelocity(this.ball, { x: 0, y: 0 });
    Body.setAngularVelocity(this.ball, 0);

    let redIndex = 0;
    let blueIndex = 0;

    for (const player of this.players.values()) {
      if (player.team === 'spectator') continue;

      const index = player.team === 'red' ? redIndex++ : blueIndex++;
      const positions = TEAM_POSITIONS[player.team];
      const pos = positions[index] ?? positions[0];

      Body.setPosition(player.body, { x: pos.x, y: pos.y });
      Body.setVelocity(player.body, { x: 0, y: 0 });
      Body.setAngularVelocity(player.body, 0);
      player.keyboard = { ...initialKeyboard };
    }
  }

  getSnapshot(): PhysicsSnapshot {
    const players: PhysicsSnapshot['players'] = {};

    for (const [id, player] of this.players.entries()) {
      players[id] = {
        x: player.body.position.x,
        y: player.body.position.y,
        velocityX: player.body.velocity.x,
        velocityY: player.body.velocity.y,
        spaceClicked: player.keyboard.spaceClicked,
      };
    }

    return {
      ball: {
        x: this.ball.position.x,
        y: this.ball.position.y,
        velocityX: this.ball.velocity.x,
        velocityY: this.ball.velocity.y,
      },
      players,
    };
  }
}
