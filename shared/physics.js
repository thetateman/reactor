import { KEY, PLAYER_SIZE, PLAYER_SPEED, SIM_STEP } from './constants.js';
import { isSolid } from './map.js';

// Movement must give identical results on server and client, because the
// client predicts its own movement and replays unacknowledged inputs on top
// of the server's position. Keep this deterministic: no randomness, no clocks.

const HALF = PLAYER_SIZE / 2;
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
  moveX(body, dx * dist, map);
  moveY(body, dy * dist, map);
}

// Each axis moves less than one tile per step, so only the leading row or
// column of tiles can newly overlap the body.
function moveX(body, delta, map) {
  if (!delta) return;
  body.x += delta;
  const top = Math.floor(body.y - HALF + EPS);
  const bottom = Math.floor(body.y + HALF - EPS);
  if (delta > 0) {
    const col = Math.floor(body.x + HALF - EPS);
    if (anySolid(map, col, col, top, bottom)) body.x = col - HALF;
  } else {
    const col = Math.floor(body.x - HALF + EPS);
    if (anySolid(map, col, col, top, bottom)) body.x = col + 1 + HALF;
  }
}

function moveY(body, delta, map) {
  if (!delta) return;
  body.y += delta;
  const left = Math.floor(body.x - HALF + EPS);
  const right = Math.floor(body.x + HALF - EPS);
  if (delta > 0) {
    const row = Math.floor(body.y + HALF - EPS);
    if (anySolid(map, left, right, row, row)) body.y = row - HALF;
  } else {
    const row = Math.floor(body.y - HALF + EPS);
    if (anySolid(map, left, right, row, row)) body.y = row + 1 + HALF;
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

// Whether a player body overlaps the given rect (used to stop doors closing on someone).
export function bodyOverlapsRect(body, rect) {
  return (
    body.x + HALF > rect.x &&
    body.x - HALF < rect.x + rect.w &&
    body.y + HALF > rect.y &&
    body.y - HALF < rect.y + rect.h
  );
}
