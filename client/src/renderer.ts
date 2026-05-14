import type { GameState, PlayerState } from './types';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Map dimensions (center-origin, matching server)
const MAP_W = 620;
const MAP_H = 300;
const FIELD_W = 550;
const FIELD_H = 240;
const GOAL_Y = 80;
const GOAL_POST_X = 550;
const GOAL_NET_X = 590;
const GOAL_POST_R = 5;
const PLAYER_R = 15;
const BALL_R = 6.4;

const CANVAS_W = MAP_W * 2;
const CANVAS_H = MAP_H * 2;

const TEAM_RED = '#FF4D6A';
const TEAM_BLUE = '#4DA6FF';
const BALL_COLOR = '#91F1B5';
const FIELD_BG = '#0a1a14';
const OUTER_BG = '#0D1117';
const LINE_COLOR = '#91F1B5';
const LINE_ALPHA = 0.35;
const GOAL_LINE_COLOR = '#FF4D6A';
const GOAL_NET_COLOR_RED = '#FF4D6A';
const GOAL_NET_COLOR_BLUE = '#4DA6FF';
const POST_COLOR = '#91F1B5';

let fieldCache: HTMLCanvasElement | null = null;

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

  // Subtle field gradient overlay
  const grad = ctx.createLinearGradient(0, cy(-FIELD_H), 0, cy(FIELD_H));
  grad.addColorStop(0, 'rgba(145, 241, 181, 0.03)');
  grad.addColorStop(0.5, 'rgba(145, 241, 181, 0.01)');
  grad.addColorStop(1, 'rgba(145, 241, 181, 0.03)');
  ctx.fillStyle = grad;
  ctx.fillRect(cx(-FIELD_W), cy(-FIELD_H), FIELD_W * 2, FIELD_H * 2);

  // Large "P" watermark in center
  ctx.save();
  ctx.font = 'bold 280px "Space Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(145, 241, 181, 0.04)';
  ctx.fillText('P', cx(0), cy(0));
  ctx.restore();

  // Field border with glow
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx(-FIELD_W), cy(-FIELD_H), FIELD_W * 2, FIELD_H * 2);

  // Center line
  ctx.beginPath();
  ctx.moveTo(cx(0), cy(-FIELD_H));
  ctx.lineTo(cx(0), cy(FIELD_H));
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), 100, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.2})`;
  ctx.fill();

  // Penalty areas
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1.5;

  // Left penalty
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-70));
  ctx.lineTo(cx(-390), cy(-70));
  ctx.lineTo(cx(-390), cy(70));
  ctx.lineTo(cx(-FIELD_W), cy(70));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx(-375), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.1})`;
  ctx.fill();

  // Right penalty
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-70));
  ctx.lineTo(cx(390), cy(-70));
  ctx.lineTo(cx(390), cy(70));
  ctx.lineTo(cx(FIELD_W), cy(70));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx(375), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.1})`;
  ctx.fill();

  // Goal nets with team color tints
  // Left net (RED team defends left)
  ctx.fillStyle = 'rgba(255, 77, 106, 0.08)';
  ctx.fillRect(cx(-GOAL_NET_X), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);

  // Cross-hatch pattern for left net
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx(-GOAL_NET_X), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 77, 106, 0.15)';
  ctx.lineWidth = 0.5;
  for (let i = -10; i < 20; i++) {
    const x = cx(-GOAL_NET_X) + i * 12;
    ctx.beginPath();
    ctx.moveTo(x, cy(-GOAL_Y));
    ctx.lineTo(x, cy(GOAL_Y));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx(-GOAL_NET_X), cy(-GOAL_Y) + i * 12);
    ctx.lineTo(cx(-FIELD_W), cy(-GOAL_Y) + i * 12);
    ctx.stroke();
  }
  ctx.restore();

  // Left net outline
  ctx.strokeStyle = 'rgba(255, 77, 106, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(GOAL_Y));
  ctx.lineTo(cx(-FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Right net (BLUE team defends right)
  ctx.fillStyle = 'rgba(77, 166, 255, 0.08)';
  ctx.fillRect(cx(FIELD_W), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);

  // Cross-hatch pattern for right net
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx(FIELD_W), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(77, 166, 255, 0.15)';
  ctx.lineWidth = 0.5;
  for (let i = -10; i < 20; i++) {
    const x = cx(FIELD_W) + i * 12;
    ctx.beginPath();
    ctx.moveTo(x, cy(-GOAL_Y));
    ctx.lineTo(x, cy(GOAL_Y));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx(FIELD_W), cy(-GOAL_Y) + i * 12);
    ctx.lineTo(cx(GOAL_NET_X), cy(-GOAL_Y) + i * 12);
    ctx.stroke();
  }
  ctx.restore();

  // Right net outline
  ctx.strokeStyle = 'rgba(77, 166, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(GOAL_NET_X), cy(-GOAL_Y));
  ctx.lineTo(cx(GOAL_NET_X), cy(GOAL_Y));
  ctx.lineTo(cx(FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Goal line marks (accent green)
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.15})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(-FIELD_W), cy(GOAL_Y));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Goal posts with glow
  for (const post of [
    [-GOAL_POST_X, -GOAL_Y], [-GOAL_POST_X, GOAL_Y],
    [GOAL_POST_X, -GOAL_Y], [GOAL_POST_X, GOAL_Y],
  ]) {
    ctx.beginPath();
    ctx.arc(cx(post[0]), cy(post[1]), GOAL_POST_R, 0, Math.PI * 2);
    ctx.fillStyle = POST_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Corner arcs
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1;
  const cornerR = 14;
  ctx.beginPath(); ctx.arc(cx(-FIELD_W), cy(-FIELD_H), cornerR, 0, Math.PI / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx(FIELD_W), cy(-FIELD_H), cornerR, Math.PI / 2, Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx(-FIELD_W), cy(FIELD_H), cornerR, -Math.PI / 2, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx(FIELD_W), cy(FIELD_H), cornerR, Math.PI, -Math.PI / 2); ctx.stroke();

  // Sub marks
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA * 0.7})`;
  ctx.lineWidth = 1;
  for (const xPos of [-381, -240, -120, 120, 240, 381]) {
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

    // Ball glow
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R + 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(145, 241, 181, 0.15)';
    ctx.fill();

    // Ball
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
