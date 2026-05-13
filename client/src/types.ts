export type Team = 'red' | 'blue' | 'spectator';

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
  winner?: 'red' | 'blue';
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
};

export type ChatMessage = {
  playerName: string;
  text: string;
  timestamp: number;
};

// Field constants (shared for rendering)
export const FIELD_WIDTH = 1000;
export const FIELD_HEIGHT = 550;
export const PLAYER_RADIUS = 20;
export const BALL_RADIUS = 10;
export const GOAL_OFFSET = 80;
export const DOOR_WIDTH = 39;
export const SCORE_LIMIT = 5;
export const MAX_TEAM_SIZE = 3;
