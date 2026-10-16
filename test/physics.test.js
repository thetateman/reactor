import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, PLAYER_SIZE, PLAYER_SPEED, SIM_STEP } from '../shared/constants.js';
import { isSolid } from '../shared/map.js';
import { stepPlayer } from '../shared/physics.js';
import { generateMap } from '../server/mapgen.js';
import { createRng } from '../server/rng.js';

const HALF = PLAYER_SIZE / 2;

function overlapsSolid(map, body) {
  const eps = 1e-6;
  for (let y = Math.floor(body.y - HALF + eps); y <= Math.floor(body.y + HALF - eps); y++) {
    for (let x = Math.floor(body.x - HALF + eps); x <= Math.floor(body.x + HALF - eps); x++) {
      if (isSolid(map, x, y)) return true;
    }
  }
  return false;
}

test('random walks never end up inside a wall or closed door', () => {
  const rng = createRng(99);
  for (let seed = 1; seed <= 40; seed++) {
    const map = generateMap(seed);
    for (const door of map.doors) door.open = rng.next() < 0.5;
    const body = { ...map.spawn };

    let keys = 0;
    for (let step = 0; step < 5000; step++) {
      if (step % 20 === 0) keys = rng.int(0, 15);
      stepPlayer(body, keys, map);
      assert.ok(!overlapsSolid(map, body), `seed ${seed}: inside a wall at step ${step}`);
    }
  }
});

test('walking into a wall stops flush against it', () => {
  const map = generateMap(5);
  const body = { ...map.spawn };
  for (let i = 0; i < 1000; i++) stepPlayer(body, KEY.UP, map);
  const wallRow = Math.floor(body.y - HALF) - 1;
  assert.ok(isSolid(map, Math.floor(body.x), wallRow));
  assert.ok(Math.abs(body.y - HALF - (wallRow + 1)) < 1e-9);
});

test('diagonal movement is no faster than straight movement', () => {
  const map = generateMap(5);
  const body = { ...map.spawn };
  const start = { ...body };
  stepPlayer(body, KEY.DOWN | KEY.RIGHT, map);
  const moved = Math.hypot(body.x - start.x, body.y - start.y);
  assert.ok(Math.abs(moved - PLAYER_SPEED * SIM_STEP) < 1e-9);
});
