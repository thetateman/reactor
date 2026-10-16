import { KEY, PLAYER_SIZE, PLAYER_SPEED, SIM_STEP } from './constants.js';
import { isSolid } from './map.js';

// Movement must give identical results on server and client, because the
// client predicts its own movement and replays unacknowledged inputs on top
// of the server's position. Keep this deterministic: no randomness, no clocks.

export const PLAYER_HALF = PLAYER_SIZE / 2;
const EPS = 1e-6;
const DIAGONAL = Math.SQRT1_2;

// Advances `body` ({ x, y }, center in tiles) by one fixed step of input.
export function stepPlayer(body, keys, map) {
  let dx = (keys & KEY.RIGHT ? 1 : 0) - (keys & KEY.LEFT ? 1 : 0);
  let dy = (keys & KEY.DOWN ? 1 : 0) - (keys & KEY.UP ? 1 : 0);
  if (dx && dy) {
    dx *= DIAGONAL;
    dy *= DIAGONAL;
  }

  const dist = PLAYER_SPEED * SIM_STEP;
  moveBody(body, dx * dist, dy * dist, PLAYER_HALF, map);
}

// Moves a square body (center `body.x`/`body.y`, half-width `half`) by
// (dx, dy), sliding along walls and closed doors. Each component must be
// less than one tile, so only the leading row or column can newly overlap.
export function moveBody(body, dx, dy, half, map) {
  moveX(body, dx, half, map);
  moveY(body, dy, half, map);
}

function moveX(body, delta, half, map) {
  if (!delta) return;
  body.x += delta;
  const top = Math.floor(body.y - half + EPS);
  const bottom = Math.floor(body.y + half - EPS);
  if (delta > 0) {
    const col = Math.floor(body.x + half - EPS);
    if (anySolid(map, col, col, top, bottom)) body.x = col - half;
  } else {
    const col = Math.floor(body.x - half + EPS);
    if (anySolid(map, col, col, top, bottom)) body.x = col + 1 + half;
  }
}

function moveY(body, delta, half, map) {
  if (!delta) return;
  body.y += delta;
  const left = Math.floor(body.x - half + EPS);
  const right = Math.floor(body.x + half - EPS);
  if (delta > 0) {
    const row = Math.floor(body.y + half - EPS);
    if (anySolid(map, left, right, row, row)) body.y = row - half;
  } else {
    const row = Math.floor(body.y - half + EPS);
    if (anySolid(map, left, right, row, row)) body.y = row + 1 + half;
  }
}

function anySolid(map, x0, x1, y0, y1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (isSolid(map, x, y)) return true;
    }
  }
  return false;
}

// Whether a square body overlaps the given rect (used to stop doors closing on someone).
export function bodyOverlapsRect(body, rect, half = PLAYER_HALF) {
  return (
    body.x + half > rect.x &&
    body.x - half < rect.x + rect.w &&
    body.y + half > rect.y &&
    body.y - half < rect.y + rect.h
  );
}
