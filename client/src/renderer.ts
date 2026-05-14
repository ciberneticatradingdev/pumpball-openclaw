import type { GameState, PlayerState } from './types';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Map dimensions (center-origin, matching server)
const MAP_W = 620;   // half-width
const MAP_H = 300;   // half-height
const FIELD_W = 550;  // inner field half-width
const FIELD_H = 240;  // inner field half-height
const GOAL_Y = 80;    // goal opening half-height
const GOAL_POST_X = 550;
const GOAL_NET_X = 590;
const GOAL_POST_R = 5;
const PLAYER_R = 15;
const BALL_R = 6.4;

// Canvas size (full map)
const CANVAS_W = MAP_W * 2;  // 1240
const CANVAS_H = MAP_H * 2;  // 600

const TEAM_RED = '#FF4D6A';
const TEAM_BLUE = '#4DA6FF';
const BALL_COLOR = '#91F1B5';
const FIELD_BG = '#1A2332';
const OUTER_BG = '#141519';
const LINE_COLOR = '#91F1B540';
const GOAL_LINE_COLOR = '#FF4D6A';
const GOAL_NET_COLOR = '#1A2332';
const POST_COLOR = '#91F1B5';

// Pre-rendered field cache
let fieldCache: HTMLCanvasElement | null = null;

// Convert center-origin to canvas coordinates
function cx(x: number): number { return x + MAP_W; }
function cy(y: number): number { return y + MAP_H; }

function buildFieldCache(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const ctx = c.getContext('2d')!;

  // Outer area
  ctx.fillStyle = OUTER_BG;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Field background
  ctx.fillStyle = FIELD_BG;
  ctx.fillRect(cx(-FIELD_W), cy(-FIELD_H), FIELD_W * 2, FIELD_H * 2);

  // Field border
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx(-FIELD_W), cy(-FIELD_H), FIELD_W * 2, FIELD_H * 2);

  // Center line
  ctx.beginPath();
  ctx.moveTo(cx(0), cy(-FIELD_H));
  ctx.lineTo(cx(0), cy(FIELD_H));
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Center circle (kickoff radius ~100)
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), 100, 0, Math.PI * 2);
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = LINE_COLOR;
  ctx.fill();

  // Penalty areas (approximate from map: x=±390, y=±70 with curves)
  // Left penalty area
  ctx.strokeStyle = GOAL_LINE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-70));
  ctx.quadraticCurveTo(cx(-390), cy(-70), cx(-390), cy(-70));
  ctx.lineTo(cx(-390), cy(70));
  ctx.quadraticCurveTo(cx(-FIELD_W), cy(70), cx(-FIELD_W), cy(70));
  ctx.stroke();

  // Left penalty arc
  ctx.beginPath();
  ctx.arc(cx(-375), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = GOAL_LINE_COLOR;
  ctx.fill();

  // Right penalty area
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-70));
  ctx.quadraticCurveTo(cx(390), cy(-70), cx(390), cy(-70));
  ctx.lineTo(cx(390), cy(70));
  ctx.quadraticCurveTo(cx(FIELD_W), cy(70), cx(FIELD_W), cy(70));
  ctx.stroke();

  // Right penalty arc
  ctx.beginPath();
  ctx.arc(cx(375), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = GOAL_LINE_COLOR;
  ctx.fill();

  // Goal nets (rectangles behind goal line)
  // Left net
  ctx.fillStyle = GOAL_NET_COLOR + '40';
  ctx.fillRect(cx(-GOAL_NET_X), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.strokeStyle = GOAL_NET_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(GOAL_Y));
  ctx.lineTo(cx(-FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Right net
  ctx.fillStyle = GOAL_NET_COLOR + '40';
  ctx.fillRect(cx(FIELD_W), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.strokeStyle = GOAL_NET_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(GOAL_NET_X), cy(-GOAL_Y));
  ctx.lineTo(cx(GOAL_NET_X), cy(GOAL_Y));
  ctx.lineTo(cx(FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Goal line marks (red vertical lines at goal opening)
  ctx.strokeStyle = GOAL_LINE_COLOR;
  ctx.lineWidth = 2;
  // Left
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(-FIELD_W), cy(GOAL_Y));
  ctx.stroke();
  // Right
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Goal posts
  for (const post of [
    [-GOAL_POST_X, -GOAL_Y], [-GOAL_POST_X, GOAL_Y],
    [GOAL_POST_X, -GOAL_Y], [GOAL_POST_X, GOAL_Y],
  ]) {
    ctx.beginPath();
    ctx.arc(cx(post[0]), cy(post[1]), GOAL_POST_R, 0, Math.PI * 2);
    ctx.fillStyle = POST_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#ffffff40';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Corner arcs (quarter circles at field corners, radius ~14)
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1;
  const cornerR = 14;
  // Top-left
  ctx.beginPath(); ctx.arc(cx(-FIELD_W), cy(-FIELD_H), cornerR, 0, Math.PI / 2); ctx.stroke();
  // Top-right
  ctx.beginPath(); ctx.arc(cx(FIELD_W), cy(-FIELD_H), cornerR, Math.PI / 2, Math.PI); ctx.stroke();
  // Bottom-left
  ctx.beginPath(); ctx.arc(cx(-FIELD_W), cy(FIELD_H), cornerR, -Math.PI / 2, 0); ctx.stroke();
  // Bottom-right
  ctx.beginPath(); ctx.arc(cx(FIELD_W), cy(FIELD_H), cornerR, Math.PI, -Math.PI / 2); ctx.stroke();

  // Substitution marks (small ticks on sidelines from map)
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1;
  for (const xPos of [-381, -240, -120, 120, 240, 381]) {
    // Bottom sideline tick
    ctx.beginPath();
    ctx.moveTo(cx(xPos), cy(FIELD_H));
    ctx.lineTo(cx(xPos), cy(FIELD_H + 16));
    ctx.stroke();
  }

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

  setMyId(id: string) { this.myId = id; }

  resize() {
    const container = this.canvas.parentElement!;
    const cw = container.clientWidth - 20;
    const ch = container.clientHeight - 20;
    const scaleX = cw / CANVAS_W;
    const scaleY = ch / CANVAS_H;
    this.scale = Math.min(scaleX, scaleY, 1.2);
    this.canvas.width = Math.floor(CANVAS_W * this.scale);
    this.canvas.height = Math.floor(CANVAS_H * this.scale);
  }

  renderInterpolated(prev: GameState | null, target: GameState, alpha: number): void {
    if (!prev) { this.render(target); return; }
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

    if (fieldCache) ctx.drawImage(fieldCache, 0, 0);

    this.drawPlayers(ctx, state.players);
    this.drawBall(ctx, state.ball);

    ctx.restore();
  }

  private drawPlayers(ctx: CanvasRenderingContext2D, players: PlayerState[]) {
    for (const player of players) {
      if (player.team === 'spectator') continue;

      const color = player.team === 'red' ? TEAM_RED : TEAM_BLUE;
      const isMe = player.id === this.myId;
      const px = cx(player.x);
      const py = cy(player.y);

      // Kick ring
      if (player.spaceClicked) {
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R + 8, 0, Math.PI * 2);
        ctx.strokeStyle = color + '50';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Player circle
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Border
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
      ctx.strokeStyle = isMe ? '#ffffff' : '#ffffff80';
      ctx.lineWidth = isMe ? 2.5 : 1.5;
      ctx.stroke();

      // Self indicator
      if (isMe) {
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff40';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Name
      ctx.fillStyle = '#ffffffcc';
      ctx.font = `${isMe ? 'bold ' : ''}10px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(player.name.slice(0, 12), px, py - PLAYER_R - 4);
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number }) {
    const bx = cx(ball.x);
    const by = cy(ball.y);

    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = BALL_COLOR;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
