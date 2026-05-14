export type Team = 'red' | 'blue' | 'spectator';

export type GameMode = '1v1' | '2v2' | '4v4';

export type Keyboard = {
  rightClicked: boolean;
  leftClicked: boolean;
  upClicked: boolean;
  downClicked: boolean;
  spaceClicked: boolean;
};

export const initialKeyboard: Keyboard = {
  rightClicked: false,
  leftClicked: false,
  upClicked: false,
  downClicked: false,
  spaceClicked: false,
};

export type PlayerState = {
  id: string;
  name: string;
  team: Team;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  spaceClicked: boolean;
};

export type GameState = {
  ball: { x: number; y: number; velocityX: number; velocityY: number };
  players: PlayerState[];
  score: { red: number; blue: number };
  status: 'waiting' | 'playing' | 'finished';
  winner?: 'red' | 'blue' | null;
  timeLeft: number;
  overtime: boolean;
};

export type RoomPlayer = {
  id: string;
  name: string;
  team: Team;
};

export type RoomInfo = {
  code: string;
  players: RoomPlayer[];
  hostId: string;
  status: 'waiting' | 'playing' | 'finished';
  score: { red: number; blue: number };
  mode: GameMode;
};

export type ChatMessage = {
  playerName: string;
  text: string;
  timestamp: number;
};

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

// Legacy exports for backward compat (all based on 4v4)
export const FIELD_WIDTH = 1000;
export const FIELD_HEIGHT = 550;
export const PLAYER_RADIUS = 20;
export const BALL_RADIUS = 10;
export const GOAL_OFFSET = 80;
export const DOOR_WIDTH = 39;
export const SCORE_LIMIT = 5;
export const MAX_TEAM_SIZE = 3;
