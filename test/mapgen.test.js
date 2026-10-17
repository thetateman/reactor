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
    assert.ok(map.rooms.length >= 4, `seed ${seed}: only ${map.rooms.length} rooms`); // hub + exit chambers

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
    assert.ok(spawn.w >= 17 && spawn.h >= 11, `seed ${seed}: spawn room is ${spawn.w}x${spawn.h}`);
    for (const room of map.rooms) {
      assert.ok(room.w * room.h <= spawn.w * spawn.h, `seed ${seed}: room ${room.id} is bigger than the spawn room`);
    }
    const center = roomCenter(spawn);
    assert.ok(Math.abs(center.x - map.width / 2) <= 2, `seed ${seed}: spawn room off-center`);
    assert.ok(Math.abs(center.y - map.height / 2) <= 2, `seed ${seed}: spawn room off-center`);
  }
});

const inside = (inner, outer) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

test('the hatch sits in its extraction zone, in a room far from spawn', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const { room, hatch, zone } = map.exit;
    assert.notEqual(room, map.spawnRoom);
    assert.ok(inside(hatch, zone), `seed ${seed}: hatch outside its zone`);
    assert.ok(inside(zone, map.rooms[room]), `seed ${seed}: zone outside the exit room`);

    // Walk from the middle of the spawn room to the hatch, through doors.
    const { width, tiles } = map;
    const start = roomCenter(map.rooms[map.spawnRoom]);
    const dist = new Map([[Math.floor(start.y) * width + Math.floor(start.x), 0]]);
    const queue = [...dist.keys()];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (!dist.has(j) && walkable(tiles[j])) {
          dist.set(j, dist.get(i) + 1);
          queue.push(j);
        }
      }
    }
    const route = dist.get(hatch.y * width + hatch.x);
    assert.ok(route >= 100, `seed ${seed}: hatch only ${route} steps from spawn`);
  }
});

test('between the rooms is a maze, with dead ends', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const map = generateMap(seed);
    const inRoom = (x, y) => map.rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    let cells = 0;
    let passage = 0;
    let deadEnds = 0;
    // Cells are the 2x2 floor squares at (3cx + 1, 3cy + 1).
    for (let y = 1; y < map.height - 1; y += 3) {
      for (let x = 1; x < map.width - 1; x += 3) {
        cells++;
        if (inRoom(x, y)) continue;
        passage++;
        const ways = [tileAt(map, x, y - 1), tileAt(map, x + 2, y), tileAt(map, x, y + 2), tileAt(map, x - 1, y)]
          .filter(walkable).length;
        if (ways === 1) deadEnds++;
      }
    }
    assert.ok(passage >= cells * 0.6, `seed ${seed}: only ${passage} of ${cells} cells are passage`);
    assert.ok(deadEnds >= 15, `seed ${seed}: only ${deadEnds} dead ends`);
  }
});

test('chambers are 3 to 4 cells on a side, and there are 12 of them', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const chambers = map.rooms.filter((r) => r.id !== map.spawnRoom);
    assert.equal(chambers.length, 12, `seed ${seed}`);
    for (const r of chambers) {
      // A room n cells wide is 3n - 1 tiles inside.
      assert.ok([8, 11].includes(r.w) && [8, 11].includes(r.h), `seed ${seed}: chamber ${r.id} is ${r.w}x${r.h}`);
    }
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
