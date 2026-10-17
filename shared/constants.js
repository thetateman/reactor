// Values shared by the server and the browser. Distances are in tiles.

export const SIM_RATE = 60; // movement steps per second, on both client and server
export const SIM_STEP = 1 / SIM_RATE;
export const TICK_RATE = 20; // server state broadcasts per second

export const PLAYER_SIZE = 0.7;
export const PLAYER_SPEED = 5; // tiles per second
export const PLAYER_MAX_HP = 10;
export const PLAYER_MAX_AMMO = 20;
export const PLAYER_START_AMMO = 0; // players have to find ammo first
export const INTERACT_RANGE = 1; // from player center to the nearest edge of a door

export const PICKUP_RANGE = 1.5; // from player center to pickup center
export const PICKUP_SIZE = 1; // drawn size of a pickup
export const AMMO_PICKUP = 20; // rounds an ammo stack gives, up to PLAYER_MAX_AMMO

export const ENEMY_RADIUS = 0.35;
export const ENEMY_MAX_HP = 3;

export const BULLET_SPEED = 30; // tiles per second
export const BULLET_RANGE = 25; // tiles

// The reactor's temperature runs from 0 (cold) to 100 (meltdown), shown on a
// dial: blue below POWER_MIN, green up to OVERHEAT_MIN, red above.
export const REACTOR_HEAT_TIME = 240; // seconds from 0 to 100 with the rod in
export const REACTOR_COOL_TIME = 240; // seconds from 100 to 0 with the rod out
export const REACTOR_POWER_MIN = 30; // the facility has power at or above this
export const REACTOR_OVERHEAT_MIN = 70;
export const REACTOR_RANGE = 1; // from player center to the reactor's edge, to use it

// Bit flags packed into each input command.
export const KEY = {
  UP: 1,
  DOWN: 2,
  LEFT: 4,
  RIGHT: 8,
  INTERACT: 16,
  SHOOT: 32, // the command also carries `aim`, an angle in radians
};
export const KEY_MASK = 63;

export const TILE = {
  VOID: 0,
  FLOOR: 1,
  WALL: 2,
  DOOR: 3,
  REACTOR: 4, // solid, drawn separately
};
