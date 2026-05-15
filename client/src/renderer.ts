import type { GameState, PlayerState, FieldConfig, GameMode } from './types';
import { getFieldConfig } from './types';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const PLAYER_R = 15;
const BALL_R = 6.4;
const GOAL_POST_R = 5;

const TEAM_RED = '#91F1B5';
const TEAM_BLUE = '#FFFFFF';
const BALL_COLOR = '#FFFFFF';
const FIELD_BG = '#0a1a14';
const OUTER_BG = '#0D1117';
const LINE_COLOR = '#91F1B5';
const LINE_ALPHA = 0.35;
const GOAL_LINE_COLOR = '#91F1B5';
const GOAL_NET_COLOR_RED = '#91F1B5';
const GOAL_NET_COLOR_BLUE = '#FFFFFF';
const POST_COLOR = '#91F1B5';

// Current field config — defaults to 4v4
let fc: FieldConfig = getFieldConfig('4v4');
let CANVAS_W = fc.MAP_W * 2;
let CANVAS_H = fc.MAP_H * 2;
let fieldCache: HTMLCanvasElement | null = null;

// Preload logo for watermark
const logoWatermark = new Image();
logoWatermark.onload = () => { fieldCache = null; }; // invalidate cache so it redraws with logo
logoWatermark.src = '/logo.png';

function cx(x: number): number { return x + fc.MAP_W; }
function cy(y: number): number { return y + fc.MAP_H; }

function buildFieldCache(): HTMLCanvasElement {
  const { FIELD_W, FIELD_H, MAP_W, MAP_H, GOAL_Y, GOAL_POST_X, GOAL_NET_X } = fc;
  CANVAS_W = MAP_W * 2;
  CANVAS_H = MAP_H * 2;

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

  // Logo watermark in center (scale with field size)
  if (logoWatermark.complete && logoWatermark.naturalWidth > 0) {
    ctx.save();
    const logoSize = Math.round(180 * (FIELD_W / 550));
    const aspect = logoWatermark.naturalWidth / logoWatermark.naturalHeight;
    const logoW = logoSize * aspect;
    const logoH = logoSize;
    ctx.globalAlpha = 0.14;
    ctx.drawImage(logoWatermark, cx(0) - logoW / 2, cy(0) - logoH / 2 + 8, logoW, logoH);
    ctx.restore();
  }

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

  // Center circle (scale proportionally)
  const centerCircleR = Math.round(100 * (FIELD_W / 550));
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), centerCircleR, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx(0), cy(0), 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.2})`;
  ctx.fill();

  // Penalty areas (scale proportionally)
  const penaltyW = Math.round(160 * (FIELD_W / 550));
  const penaltyH = Math.round(70 * (FIELD_H / 240));
  const penaltyDotOffset = Math.round(175 * (FIELD_W / 550));
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA})`;
  ctx.lineWidth = 1.5;

  // Left penalty
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-penaltyH));
  ctx.lineTo(cx(-FIELD_W + penaltyW), cy(-penaltyH));
  ctx.lineTo(cx(-FIELD_W + penaltyW), cy(penaltyH));
  ctx.lineTo(cx(-FIELD_W), cy(penaltyH));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx(-FIELD_W + penaltyDotOffset), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.1})`;
  ctx.fill();

  // Right penalty
  ctx.beginPath();
  ctx.moveTo(cx(FIELD_W), cy(-penaltyH));
  ctx.lineTo(cx(FIELD_W - penaltyW), cy(-penaltyH));
  ctx.lineTo(cx(FIELD_W - penaltyW), cy(penaltyH));
  ctx.lineTo(cx(FIELD_W), cy(penaltyH));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx(FIELD_W - penaltyDotOffset), cy(0), 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(145, 241, 181, ${LINE_ALPHA + 0.1})`;
  ctx.fill();

  // Goal nets with team color tints
  // Left net (RED/mint team defends left)
  ctx.fillStyle = 'rgba(145, 241, 181, 0.08)';
  ctx.fillRect(cx(-GOAL_NET_X), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);

  // Cross-hatch pattern for left net
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx(-GOAL_NET_X), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(145, 241, 181, 0.15)';
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
  ctx.strokeStyle = 'rgba(145, 241, 181, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx(-FIELD_W), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(-GOAL_Y));
  ctx.lineTo(cx(-GOAL_NET_X), cy(GOAL_Y));
  ctx.lineTo(cx(-FIELD_W), cy(GOAL_Y));
  ctx.stroke();

  // Right net (WHITE team defends right)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(cx(FIELD_W), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);

  // Cross-hatch pattern for right net
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx(FIELD_W), cy(-GOAL_Y), GOAL_NET_X - FIELD_W, GOAL_Y * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
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
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
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

  // Sub marks (scale proportionally)
  ctx.strokeStyle = `rgba(145, 241, 181, ${LINE_ALPHA * 0.7})`;
  ctx.lineWidth = 1;
  const subMarkPositions = [-381, -240, -120, 120, 240, 381].map(p => Math.round(p * (FIELD_W / 550)));
  for (const xPos of subMarkPositions) {
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
  private avatarCache: Map<string, HTMLImageElement> = new Map();
  private avatarLoading: Set<string> = new Set();
  private currentMode: GameMode = '4v4';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    if (!fieldCache) fieldCache = buildFieldCache();
    this.resize();
  }

  setMyId(id: string) { this.myId = id; }

  setFieldConfig(mode: GameMode) {
    if (mode === this.currentMode && fieldCache) return;
    this.currentMode = mode;
    fc = getFieldConfig(mode);
    CANVAS_W = fc.MAP_W * 2;
    CANVAS_H = fc.MAP_H * 2;
    // Invalidate and rebuild the field cache
    fieldCache = buildFieldCache();
    this.resize();
  }

  setPlayerAvatar(id: string, dataUrl: string) {
    if (this.avatarLoading.has(id)) return;
    this.avatarLoading.add(id);
    const img = new Image();
    img.onload = () => {
      this.avatarCache.set(id, img);
      this.avatarLoading.delete(id);
    };
    img.onerror = () => {
      this.avatarLoading.delete(id);
    };
    img.src = dataUrl;
  }

  removePlayerAvatar(id: string) {
    this.avatarCache.delete(id);
    this.avatarLoading.delete(id);
  }

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
      const glowColor = player.team === 'red' ? 'rgba(145, 241, 181, 0.3)' : 'rgba(255, 255, 255, 0.25)';
      const isMe = player.id === this.myId;
      const px = cx(player.x);
      const py = cy(player.y);
      const avatar = this.avatarCache.get(player.id);

      // Team glow aura — solid ring, no shadowBlur
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_R + 5, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();

      // Kick ring — team-colored
      if (player.spaceClicked) {
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R + 8, 0, Math.PI * 2);
        ctx.strokeStyle = color + '80';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (avatar) {
        // Draw avatar image clipped to circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, px - PLAYER_R, py - PLAYER_R, PLAYER_R * 2, PLAYER_R * 2);
        ctx.restore();
      } else {
        // Fallback: solid team color circle
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      // Border — thick team colored ring (always visible on top of avatar)
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = isMe ? 4 : 3.5;
      ctx.stroke();

      // Self indicator
      if (isMe) {
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff40';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Name — team-colored, positioned above player
      const nameY = py - PLAYER_R - 6;
      ctx.fillStyle = color;
      ctx.font = `${isMe ? 'bold ' : ''}10px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(player.name.slice(0, 12), px, nameY);

      // Team indicator dot above the name
      ctx.beginPath();
      ctx.arc(px, nameY - 14, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number }) {
    const bx = cx(ball.x);
    const by = cy(ball.y);

    // Ball glow (mint green)
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(145, 241, 181, 0.2)';
    ctx.fill();

    // Ball (white core)
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = BALL_COLOR;
    ctx.fill();

    // Mint green ring to distinguish from white team
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#91F1B5';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
}
