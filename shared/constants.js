// Values shared by the server and the browser. Distances are in tiles.

export const SIM_RATE = 60; // movement steps per second, on both client and server
export const SIM_STEP = 1 / SIM_RATE;
export const TICK_RATE = 20; // server state broadcasts per second

export const PLAYER_SIZE = 0.7;
export const PLAYER_SPEED = 5; // tiles per second
export const INTERACT_RANGE = 1; // from player center to the nearest edge of a door

// Bit flags packed into each input command.
export const KEY = {
  UP: 1,
  DOWN: 2,
  LEFT: 4,
  RIGHT: 8,
  INTERACT: 16,
};
export const KEY_MASK = 31;

export const TILE = {
  VOID: 0,
  FLOOR: 1,
  WALL: 2,
  DOOR: 3,
};
