import type { GameState, PlayerState } from './types';

const FIELD_W = 1000;
const FIELD_H = 550;
const PLAYER_R = 20;
const BALL_R = 10;
const GOAL_OFFSET = 80;
const DOOR_W = 39;

const TEAM_RED = '#ff3860';
const TEAM_BLUE = '#00d1ff';
const BALL_COLOR = '#00e676';
const FIELD_BG = '#0a1628';
const MARKING = '#00e67640';
const MARKING_BRIGHT = '#00e67666';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private myId: string = '';
  private scale: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
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

  render(state: GameState) {
    const { ctx, scale } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.save();
    ctx.scale(scale, scale);

    this.drawField(ctx);
    this.drawPlayers(ctx, state.players);
    this.drawBall(ctx, state.ball);

    ctx.restore();
  }

  private drawField(ctx: CanvasRenderingContext2D) {
    // Background
    ctx.fillStyle = FIELD_BG;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    // Field border
    ctx.strokeStyle = MARKING_BRIGHT;
    ctx.lineWidth = 2;
    const border = PLAYER_R * 2;
    ctx.strokeRect(border, border, FIELD_W - border * 2, FIELD_H - border * 2);

    // Center line
    ctx.beginPath();
    ctx.moveTo(FIELD_W / 2, border);
    ctx.lineTo(FIELD_W / 2, FIELD_H - border);
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

    // Left goal (red side — blue scores here)
    ctx.strokeStyle = '#ff386080';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(GOAL_OFFSET, goalTop);
    ctx.lineTo(GOAL_OFFSET - DOOR_W, goalTop);
    ctx.lineTo(GOAL_OFFSET - DOOR_W, goalBot);
    ctx.lineTo(GOAL_OFFSET, goalBot);
    ctx.stroke();

    // Left goal fill
    ctx.fillStyle = '#ff386010';
    ctx.fillRect(GOAL_OFFSET - DOOR_W, goalTop, DOOR_W, goalBot - goalTop);

    // Right goal (blue side — red scores here)
    ctx.strokeStyle = '#00d1ff80';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(FIELD_W - GOAL_OFFSET, goalTop);
    ctx.lineTo(FIELD_W - GOAL_OFFSET + DOOR_W, goalTop);
    ctx.lineTo(FIELD_W - GOAL_OFFSET + DOOR_W, goalBot);
    ctx.lineTo(FIELD_W - GOAL_OFFSET, goalBot);
    ctx.stroke();

    // Right goal fill
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
        ctx.strokeStyle = color + '80';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Glow for self
      if (isMe) {
        ctx.beginPath();
        ctx.arc(player.x, player.y, PLAYER_R + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff30';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Shadow/glow
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();

      // Stroke
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, Math.PI * 2);
      ctx.strokeStyle = isMe ? '#ffffff' : '#ffffff80';
      ctx.lineWidth = isMe ? 2 : 1.5;
      ctx.stroke();

      // Player name
      ctx.fillStyle = '#ffffffcc';
      ctx.font = `${isMe ? 'bold ' : ''}10px 'Space Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(player.name.slice(0, 12), player.x, player.y - PLAYER_R - 4);
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number }) {
    // Glow
    const grad = ctx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, BALL_R * 3);
    grad.addColorStop(0, '#00e67640');
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R * 3, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Ball shadow
    ctx.save();
    ctx.shadowColor = BALL_COLOR;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = BALL_COLOR;
    ctx.fill();
    ctx.restore();

    // Ball stroke
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
