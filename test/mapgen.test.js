import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE } from '../shared/constants.js';
import { indexRooms, tileAt } from '../shared/map.js';
import { LEVEL, generateMap } from '../server/mapgen.js';

const SEEDS = Array.from({ length: 300 }, (_, i) => i * 7919 + 1);

const walkable = (tile) => tile === TILE.FLOOR || tile === TILE.DOOR;

// A floor spot in the spawn room, just left of the reactor in its middle (the room's center is the reactor).
const besideReactor = ({ reactor }) => ({ x: reactor.x - 0.5, y: reactor.y + reactor.h / 2 });

test('same seed produces the same map', () => {
  const a = generateMap(1234);
  const b = generateMap(1234);
  assert.deepEqual(a.tiles, b.tiles);
  assert.deepEqual(a.doors, b.doors);
  assert.deepEqual(a.rooms, b.rooms);
  assert.deepEqual(a.exit, b.exit);
});

test('every walkable tile is reachable from spawn, with doors open', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const { width, tiles } = map;
    const spawn = besideReactor(map);
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

const inside = (inner, outer) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

const floorArea = (room) => room.rects.reduce((sum, r) => sum + r.w * r.h, 0);

test('the level is all rooms: every walkable tile but the doors is in exactly one', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const covered = new Uint8Array(map.tiles.length);
    for (const room of map.rooms) {
      for (const r of room.rects) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const i = y * map.width + x;
            assert.equal(covered[i], 0, `seed ${seed}: rooms overlap at ${x},${y}`);
            covered[i] = 1;
            assert.ok([TILE.FLOOR, TILE.REACTOR].includes(map.tiles[i]), `seed ${seed}: room ${room.id} covers a wall`);
          }
        }
      }
    }
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === TILE.FLOOR) assert.ok(covered[i], `seed ${seed}: floor tile ${i} is outside the rooms`);
    }
    assert.deepEqual(map.roomAt, indexRooms(map));
  }
});

test(`there are ${LEVEL.rooms[0]} to ${LEVEL.rooms[1]} rooms, about a quarter to a third of them merged from two or three rectangles`, () => {
  let merged = 0;
  let rooms = 0;
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    assert.ok(map.rooms.length >= LEVEL.rooms[0] && map.rooms.length <= LEVEL.rooms[1], `seed ${seed}: ${map.rooms.length} rooms`);
    map.rooms.forEach((room, i) => assert.equal(room.id, i));
    for (const room of map.rooms) {
      // A merged room is its rectangles plus the strip of opened wall between each pair.
      assert.ok([1, 3, 5].includes(room.rects.length), `seed ${seed}: room ${room.id} has ${room.rects.length} rects`);
      if (room.rects.length > 1) merged++;
    }
    rooms += map.rooms.length;
  }
  const share = merged / rooms;
  assert.ok(share >= 0.2 && share <= 0.35, `${(share * 100).toFixed(1)}% of rooms merged`);
});

test('merged rooms have proper corners, not slight jogs or plain rectangles', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    for (const room of map.rooms) {
      if (room.rects.length === 1) continue;
      const xs = room.rects.flatMap((r) => [r.x, r.x + r.w]);
      const ys = room.rects.flatMap((r) => [r.y, r.y + r.h]);
      const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      assert.ok(floorArea(room) <= box - 9, `seed ${seed}: room ${room.id} is nearly a rectangle`);
    }
  }
});

test('every rectangle of every room is at least 4 tiles across', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    for (const room of map.rooms) {
      // Rects 1 tile thick are opened walls between the others.
      for (const r of room.rects.filter((r) => r.w > 1 && r.h > 1)) {
        assert.ok(r.w >= 4 && r.h >= 4, `seed ${seed}: room ${room.id} has a ${r.w}x${r.h} part`);
      }
    }
  }
});

test('doors are straight runs set in a wall, joining two different rooms', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const joined = new Set();
    let doorTiles = 0;
    for (const door of map.doors) {
      assert.ok((door.w === 2 && door.h === 1) || (door.w === 1 && door.h === 2), `seed ${seed}: door ${door.id} is ${door.w}x${door.h}`);
      const horizontal = door.h === 1;
      const sides = new Set();
      for (let y = door.y; y < door.y + door.h; y++) {
        for (let x = door.x; x < door.x + door.w; x++) {
          doorTiles++;
          assert.equal(map.doorAt[y * map.width + x], door.id);
          const [ax, ay, bx, by] = horizontal ? [x, y - 1, x, y + 1] : [x - 1, y, x + 1, y];
          assert.equal(tileAt(map, ax, ay), TILE.FLOOR, `seed ${seed}: door ${door.id} blocked`);
          assert.equal(tileAt(map, bx, by), TILE.FLOOR, `seed ${seed}: door ${door.id} blocked`);
          sides.add(map.roomAt[ay * map.width + ax]).add(map.roomAt[by * map.width + bx]);
        }
      }
      // And with wall, not another door, at either end.
      const [ex, ey, fx, fy] = horizontal
        ? [door.x - 1, door.y, door.x + door.w, door.y]
        : [door.x, door.y - 1, door.x, door.y + door.h];
      assert.equal(tileAt(map, ex, ey), TILE.WALL, `seed ${seed}: door ${door.id} not set in a wall`);
      assert.equal(tileAt(map, fx, fy), TILE.WALL, `seed ${seed}: door ${door.id} not set in a wall`);

      assert.equal(sides.size, 2, `seed ${seed}: door ${door.id} doesn't join two rooms`);
      const pair = [...sides].sort((a, b) => a - b).join(',');
      assert.ok(!joined.has(pair), `seed ${seed}: two doors between rooms ${pair}`);
      joined.add(pair);
    }
    assert.equal(doorTiles, map.tiles.filter((t) => t === TILE.DOOR).length);
    // A spanning tree needs one fewer door than there are rooms; the rest make loops.
    assert.ok(map.doors.length >= map.rooms.length + 5, `seed ${seed}: only ${map.doors.length} doors`);
  }
});

test('players spawn in a large rectangular room in the middle of the map', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const { rects } = map.rooms[map.spawnRoom];
    assert.equal(rects.length, 1, `seed ${seed}: spawn room isn't a rectangle`);
    const [spawn] = rects;
    assert.ok(spawn.w >= 17 && spawn.h >= 11, `seed ${seed}: spawn room is ${spawn.w}x${spawn.h}`);
    assert.equal(spawn.x + spawn.w / 2, map.width / 2, `seed ${seed}: spawn room off-center`);
    assert.equal(spawn.y + spawn.h / 2, map.height / 2, `seed ${seed}: spawn room off-center`);
  }
});

test('the hatch sits in its extraction zone, in a room far from spawn', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const { room, hatch, zone } = map.exit;
    assert.notEqual(room, map.spawnRoom);
    assert.ok(inside(hatch, zone), `seed ${seed}: hatch outside its zone`);
    assert.ok(map.rooms[room].rects.some((r) => inside(zone, r)), `seed ${seed}: zone outside the exit room`);

    // Walk from the middle of the spawn room to the hatch, through doors.
    const { width, tiles } = map;
    const start = besideReactor(map);
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
    assert.ok(route >= LEVEL.minExitRoute, `seed ${seed}: hatch only ${route} steps from spawn`);
  }
});

test('the spawn room has doors on at least two different walls', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const [r] = map.rooms[map.spawnRoom].rects;
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

test('a level of a different size and room count can be generated', () => {
  const level = { ...LEVEL, width: 61, height: 45, rooms: [12, 16], minExitRoute: 40 };
  for (const seed of SEEDS.slice(0, 50)) {
    const map = generateMap(seed, level);
    assert.equal(map.width, 61);
    assert.ok(map.rooms.length >= 12 && map.rooms.length <= 16, `seed ${seed}: ${map.rooms.length} rooms`);
  }
});
