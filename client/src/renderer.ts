import type { GameState, PlayerState } from './types';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const FIELD_W = 1000;
const FIELD_H = 550;
const PLAYER_R = 15;
const BALL_R = 10;
const GOAL_OFFSET = 80;
const DOOR_W = 39;
const BORDER = PLAYER_R * 2; // 40 — inner field offset

const TEAM_RED = '#ff3860';
const TEAM_BLUE = '#00d1ff';
const BALL_COLOR = '#00e676';
const FIELD_BG = '#0a1628';
const MARKING = '#00e67640';
const MARKING_BRIGHT = '#00e67666';

// Pre-rendered field (static, drawn once)
let fieldCache: HTMLCanvasElement | null = null;

function buildFieldCache(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = FIELD_W;
  c.height = FIELD_H;
  const ctx = c.getContext('2d')!;

  // Background
  ctx.fillStyle = FIELD_BG;
  ctx.fillRect(0, 0, FIELD_W, FIELD_H);

  // Field border
  ctx.strokeStyle = MARKING_BRIGHT;
  ctx.lineWidth = 2;
  ctx.strokeRect(BORDER, BORDER, FIELD_W - BORDER * 2, FIELD_H - BORDER * 2);

  // Center line
  ctx.beginPath();
  ctx.moveTo(FIELD_W / 2, BORDER);
  ctx.lineTo(FIELD_W / 2, FIELD_H - BORDER);
  ctx.strokeStyle = MARKING;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(FIELD_W / 2, FIELD_H / 2, 80, 0, Math.PI * 2);
  ctx.strokeStyle = MARKING;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(FIELD_W / 2, FIELD_H / 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = MARKING_BRIGHT;
  ctx.fill();

  const goalTop = FIELD_H / 3;
  const goalBot = (FIELD_H * 2) / 3;

  // Left goal
  ctx.strokeStyle = '#ff386080';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(GOAL_OFFSET, goalTop);
  ctx.lineTo(GOAL_OFFSET - DOOR_W, goalTop);
  ctx.lineTo(GOAL_OFFSET - DOOR_W, goalBot);
  ctx.lineTo(GOAL_OFFSET, goalBot);
  ctx.stroke();
  ctx.fillStyle = '#ff386010';
  ctx.fillRect(GOAL_OFFSET - DOOR_W, goalTop, DOOR_W, goalBot - goalTop);

  // Right goal
  ctx.strokeStyle = '#00d1ff80';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(FIELD_W - GOAL_OFFSET, goalTop);
  ctx.lineTo(FIELD_W - GOAL_OFFSET + DOOR_W, goalTop);
  ctx.lineTo(FIELD_W - GOAL_OFFSET + DOOR_W, goalBot);
  ctx.lineTo(FIELD_W - GOAL_OFFSET, goalBot);
  ctx.stroke();
  ctx.fillStyle = '#00d1ff10';
  ctx.fillRect(FIELD_W - GOAL_OFFSET, goalTop, DOOR_W, goalBot - goalTop);

  // Goal line markers
  ctx.strokeStyle = '#ff386050';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GOAL_OFFSET, goalTop);
  ctx.lineTo(GOAL_OFFSET, goalBot);
  ctx.stroke();

  ctx.strokeStyle = '#00d1ff50';
  ctx.beginPath();
  ctx.moveTo(FIELD_W - GOAL_OFFSET, goalTop);
  ctx.lineTo(FIELD_W - GOAL_OFFSET, goalBot);
  ctx.stroke();

  return c;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private myId: string = '';
  private scale: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    if (!fieldCache) fieldCache = buildFieldCache();
    this.resize();
  }

  setMyId(id: string) {
    this.myId = id;
  }

  resize() {
    const container = this.canvas.parentElement!;
    const cw = container.clientWidth - 20;
    const ch = container.clientHeight - 20;

    const scaleX = cw / FIELD_W;
    const scaleY = ch / FIELD_H;
    this.scale = Math.min(scaleX, scaleY, 1);

    this.canvas.width = Math.floor(FIELD_W * this.scale);
    this.canvas.height = Math.floor(FIELD_H * this.scale);
  }

  renderInterpolated(prev: GameState | null, target: GameState, alpha: number): void {
    if (!prev) {
      this.render(target);
      return;
    }

    const ball = {
      x: lerp(prev.ball.x, target.ball.x, alpha),
      y: lerp(prev.ball.y, target.ball.y, alpha),
    };

    const prevMap = new Map(prev.players.map((p) => [p.id, p]));
    const players: PlayerState[] = target.players.map((p) => {
      const pp = prevMap.get(p.id);
      if (!pp) return p;
      return { ...p, x: lerp(pp.x, p.x, alpha), y: lerp(pp.y, p.y, alpha) };
    });

    this.render({ ...target, ball, players });
  }

  render(state: GameState) {
    const { ctx, scale } = this;

    ctx.save();
    ctx.scale(scale, scale);

    // Draw cached field (single drawImage, no recalculation)
    if (fieldCache) {
      ctx.drawImage(fieldCache, 0, 0);
    }

    // Draw entities (no shadows, no gradients)
    this.drawPlayers(ctx, state.players);
    this.drawBall(ctx, state.ball);

    ctx.restore();
  }

  private drawPlayers(ctx: CanvasRenderingContext2D, players: PlayerState[]) {
    for (const player of players) {
      if (player.team === 'spectator') continue;

      const color = player.team === 'red' ? TEAM_RED : TEAM_BLUE;
      const isMe = player.id === this.myId;

      // Kick ring
      if (player.spaceClicked) {
        ctx.beginPath();
        ctx.arc(player.x, player.y, PLAYER_R + 10, 0, Math.PI * 2);
        ctx.strokeStyle = color + '60';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Player circle
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Border
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, Math.PI * 2);
      ctx.strokeStyle = isMe ? '#ffffff' : '#ffffff80';
      ctx.lineWidth = isMe ? 2.5 : 1.5;
      ctx.stroke();

      // Self indicator ring
      if (isMe) {
        ctx.beginPath();
        ctx.arc(player.x, player.y, PLAYER_R + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff40';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Player name
      ctx.fillStyle = '#ffffffcc';
      ctx.font = `${isMe ? 'bold ' : ''}10px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(player.name.slice(0, 12), player.x, player.y - PLAYER_R - 4);
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number }) {
    // Ball
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = BALL_COLOR;
    ctx.fill();

    // Ball stroke
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
