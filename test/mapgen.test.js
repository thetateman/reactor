import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE } from '../shared/constants.js';
import { roomCenter, tileAt } from '../shared/map.js';
import { generateMap } from '../server/mapgen.js';

const SEEDS = Array.from({ length: 300 }, (_, i) => i * 7919 + 1);

const walkable = (tile) => tile === TILE.FLOOR || tile === TILE.DOOR;

test('same seed produces the same map', () => {
  const a = generateMap(1234);
  const b = generateMap(1234);
  assert.deepEqual(a.tiles, b.tiles);
  assert.deepEqual(a.doors, b.doors);
  assert.equal(a.spawnRoom, b.spawnRoom);
});

test('every walkable tile is reachable from spawn, with doors open', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const { width, tiles } = map;
    const spawn = roomCenter(map.rooms[map.spawnRoom]);
    const start = Math.floor(spawn.y) * width + Math.floor(spawn.x);
    assert.equal(tiles[start], TILE.FLOOR, `seed ${seed}: spawn is not on floor`);

    const seen = new Uint8Array(tiles.length);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tile = tileAt(map, x + dx, y + dy);
        const j = (y + dy) * width + (x + dx);
        if (walkable(tile) && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }

    for (let i = 0; i < tiles.length; i++) {
      if (walkable(tiles[i])) assert.ok(seen[i], `seed ${seed}: tile ${i} unreachable`);
    }
  }
});

test('walkable space is fully enclosed by walls', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!walkable(tileAt(map, x, y))) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            assert.notEqual(tileAt(map, x + dx, y + dy), TILE.VOID, `seed ${seed}: leak at ${x},${y}`);
          }
        }
      }
    }
  }
});

test('doors are straight runs set in a wall, with floor on both sides', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    assert.equal(map.rooms.length, 12);

    let doorTiles = 0;
    for (const door of map.doors) {
      assert.ok(door.w === 1 || door.h === 1, `seed ${seed}: door ${door.id} is not a straight run`);
      const horizontal = door.h === 1;
      for (let y = door.y; y < door.y + door.h; y++) {
        for (let x = door.x; x < door.x + door.w; x++) {
          doorTiles++;
          assert.equal(map.doorAt[y * map.width + x], door.id);
          const [ax, ay, bx, by] = horizontal ? [x, y - 1, x, y + 1] : [x - 1, y, x + 1, y];
          assert.equal(tileAt(map, ax, ay), TILE.FLOOR, `seed ${seed}: door ${door.id} blocked`);
          assert.equal(tileAt(map, bx, by), TILE.FLOOR, `seed ${seed}: door ${door.id} blocked`);
        }
      }
    }
    assert.equal(doorTiles, map.tiles.filter((t) => t === TILE.DOOR).length);
  }
});

test('players spawn in a large room in the middle of the map', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const spawn = map.rooms[map.spawnRoom];
    assert.ok(spawn.w >= 16 && spawn.h >= 12, `seed ${seed}: spawn room is ${spawn.w}x${spawn.h}`);
    for (const room of map.rooms) {
      assert.ok(room.w * room.h <= spawn.w * spawn.h, `seed ${seed}: room ${room.id} is bigger than the spawn room`);
    }
    const center = roomCenter(spawn);
    assert.ok(Math.abs(center.x - map.width / 2) <= map.width * 0.1, `seed ${seed}: spawn room off-center`);
    assert.ok(Math.abs(center.y - map.height / 2) <= map.height * 0.1, `seed ${seed}: spawn room off-center`);
  }
});

test('the spawn room has doors on at least two different walls', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const r = map.rooms[map.spawnRoom];
    const walls = new Set();
    for (const d of map.doors) {
      const alongX = d.h === 1 && d.x >= r.x && d.x < r.x + r.w;
      const alongY = d.w === 1 && d.y >= r.y && d.y < r.y + r.h;
      if (alongX && d.y === r.y - 1) walls.add('top');
      if (alongX && d.y === r.y + r.h) walls.add('bottom');
      if (alongY && d.x === r.x - 1) walls.add('left');
      if (alongY && d.x === r.x + r.w) walls.add('right');
    }
    assert.ok(walls.size >= 2, `seed ${seed}: exits only on ${[...walls]}`);
  }
});
