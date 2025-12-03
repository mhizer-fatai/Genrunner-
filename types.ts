
export enum GameState {
  MENU = 'MENU',
  LOBBY = 'LOBBY',
  PLAYING = 'PLAYING',
  SPECTATING = 'SPECTATING',
  GAME_OVER = 'GAME_OVER',
}

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Entity {
  id: string;
  pos: Position;
  size: Size;
  speed: number;
  color: string;
  type: 'player' | 'enemy' | 'coin';
  toDelete?: boolean; // Helper to remove entities after collision
}

export interface Particle {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

export interface GameScore {
  current: number;
  best: number;
  coins: number;
  lives: number;
}

// Multiplayer Types
export interface RoomPlayer {
  uid: string;
  displayName: string;
  score: number;
  isHost: boolean;
  status: 'ready' | 'playing' | 'crashed' | 'finished';
}

export interface RoomData {
  id: string;
  createdAt: number;
  status: 'waiting' | 'playing' | 'finished';
  startTime?: number;
  players: Record<string, RoomPlayer>;
}
