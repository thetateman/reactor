import { TILE } from '../shared/constants.js';
import { indexDoors, indexRooms } from '../shared/map.js';
import { createRng } from './rng.js';

// Procedural levels made entirely of rooms, like the floor plan of a building:
// neighbouring rooms share the 1-tile wall between them, and there are no hallways.
//   1. Put the control room (the hub) in the middle of the map, and divide the
//      space around it into four blocks arranged like a pinwheel, so no wall
//      runs straight across the whole map.
//   2. Split the blocks into rectangles, roughly largest first, until there are
//      enough of them.
//   3. Merge some pairs of neighbouring rectangles into one room by opening up
//      the wall between them, giving L, Z and T shapes (and now and then a
//      room of three).
//   4. Connect the rooms with doors: first along a random spanning tree, so
//      every room can be reached, then on many of the other shared walls, so
//      there are plenty of alternate routes. The hub always has doors on at
//      least two of its walls.
//   5. Put the reactor, a solid block, in the middle of the hub, and the exit
//      hatch, inside its extraction zone, in the room that's the longest walk
//      from spawn.

// Level 1. Other levels can pass their own settings to generateMap.
export const LEVEL = {
  width: 81, // tiles, outer walls included; both minus the hub's size must be even,
  height: 63, // so the hub sits exactly in the middle
  rooms: [25, 35], // how many, the hub included
  merged: [0.25, 0.33], // share of the rooms made of two or three rectangles
  loops: 0.5, // chance that neighbouring rooms not joined by the spanning tree get a door anyway
  minExitRoute: 70, // tiles walked from beside the reactor to the hatch
};

const HUB_W = 17; // tiles inside the walls
const HUB_H = 11;
const MIN_SIDE = 4; // tiles inside the walls, of the rectangles rooms are made of
const SPLIT = [0.3, 0.7]; // where a rectangle can be split, as a share of its length
const SPLIT_JITTER = 0.15; // how loosely "longest first" is followed when splitting
const MAX_MERGED = 3; // rectangles in one room
const MERGED_AREA = 1.5; // merged rooms have at most this many times the hub's floor
const MERGE_JITTER = 0.5; // how loosely "smallest first" is followed when merging
const NOTCH = 3; // a merged room's outline steps in or out by at least this many tiles
const PREFER_PAIRS = 0.8; // chance a merge joins two plain rectangles, when it can
const DOOR_SIZE = 2; // tiles
const SPAWN_ROOM = 0; // room id of the hub
const SPAWN_EXITS = 2; // the hub has doors on at least this many walls
const HATCH_SIZE = 2; // tiles
const ZONE_SIZE = 6; // tiles
const REACTOR_SIZE = 3; // tiles

export function generateMap(seed, level = LEVEL) {
  if ((level.width - HUB_W) % 2 || (level.height - HUB_H) % 2) {
    throw new Error(`a ${level.width}x${level.height} map can't have the hub exactly in the middle`);
  }
  const rng = createRng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const map = tryGenerate(rng, level);
    if (map) return map;
  }
  throw new Error(`could not generate a map for seed ${seed}`);
}

// Rectangles are { x, y, w, h }: the floor inside their walls, in tiles.
// Rectangle 0 is the hub.
function tryGenerate(rng, level) {
  const roomCount = rng.int(...level.rooms);
  const merges = Math.round(roomCount * between(rng, level.merged));
  const hub = {
    x: (level.width - HUB_W) / 2,
    y: (level.height - HUB_H) / 2,
    w: HUB_W,
    h: HUB_H,
  };
  const rects = [hub, ...split(rng, blocks(rng, level, hub), roomCount - 1 + merges)];
  const walls = sharedWalls(rects);

  const { group, openings } = merge(rng, rects, walls, merges, hub.w * hub.h * MERGED_AREA);
  const { rooms, roomOf } = makeRooms(rects, group, openings);
  if (rooms.length < level.rooms[0] || rooms.length > level.rooms[1]) return null;
  const doors = connect(rng, rects, walls, roomOf, rooms.length, level.loops);
  if (!doors) return null;

  const map = buildMap(level, rooms, doors);
  placeReactor(map);
  const exit = placeExit(map, rects, roomOf, level.minExitRoute);
  if (!exit) return null;
  map.exit = exit;
  return map;
}

// The four blocks around the hub. Each runs along one of the hub's walls and
// on past its corner to the edge of the map, all turning the same way, like a
// pinwheel; which way is mirrored at random.
function blocks(rng, { width, height }, hub) {
  const left = hub.x - 1; // the hub's walls
  const right = hub.x + hub.w;
  const top = hub.y - 1;
  const bottom = hub.y + hub.h;
  const pinwheel = [
    { x: 1, y: 1, w: left - 1, h: bottom - 1 },
    { x: left + 1, y: 1, w: width - 2 - left, h: top - 1 },
    { x: right + 1, y: top + 1, w: width - 2 - right, h: height - 2 - top },
    { x: 1, y: bottom + 1, w: right - 1, h: height - 2 - bottom },
  ];
  const flipX = rng.next() < 0.5;
  const flipY = rng.next() < 0.5;
  return pinwheel.map((r) => ({
    ...r,
    x: flipX ? width - r.x - r.w : r.x,
    y: flipY ? height - r.y - r.h : r.y,
  }));
}

const canHalve = (length) => length >= MIN_SIDE * 2 + 1; // two halves and the wall between

// Splits rectangles in two, with a wall between the halves, until there are
// `count`, roughly longest first so none end up much bigger than the rest.
function split(rng, blocks, count) {
  const rects = [...blocks];
  while (rects.length < count) {
    const options = rects.filter((r) => canHalve(r.w) || canHalve(r.h));
    if (!options.length) break;
    const pick = pickBy(rng, options, (r) => -Math.max(r.w, r.h), SPLIT_JITTER);
    rects.splice(rects.indexOf(pick), 1, ...halve(rng, pick));
  }
  return rects;
}

// Cuts across the longer side (either way if it's close to square), somewhere
// in the middle part of it.
function halve(rng, r) {
  let vertical = r.w > r.h * 1.25 ? true : r.h > r.w * 1.25 ? false : rng.next() < 0.5;
  if (!canHalve(vertical ? r.w : r.h)) vertical = !vertical;
  const length = vertical ? r.w : r.h;
  const first = rng.int(
    Math.max(MIN_SIDE, Math.round(length * SPLIT[0])),
    Math.min(length - 1 - MIN_SIDE, Math.round(length * SPLIT[1]) - 1),
  );
  const rest = length - first - 1;
  return vertical
    ? [{ ...r, w: first }, { ...r, x: r.x + first + 1, w: rest }]
    : [{ ...r, h: first }, { ...r, y: r.y + first + 1, h: rest }];
}

// Every stretch of wall with rectangle `a` on one side and `b` on the other,
// as { a, b, x, y, w, h, length }: a 1-tile-thick rect of wall tiles, with
// `a` to its left or above it.
function sharedWalls(rects) {
  const walls = [];
  rects.forEach((p, a) => rects.forEach((q, b) => {
    if (p.x + p.w + 1 === q.x) {
      const y = Math.max(p.y, q.y);
      const length = Math.min(p.y + p.h, q.y + q.h) - y;
      if (length > 0) walls.push({ a, b, x: p.x + p.w, y, w: 1, h: length, length });
    }
    if (p.y + p.h + 1 === q.y) {
      const x = Math.max(p.x, q.x);
      const length = Math.min(p.x + p.w, q.x + q.w) - x;
      if (length > 0) walls.push({ a, b, x, y: p.y + p.h, w: length, h: 1, length });
    }
  }));
  return walls;
}

// Merges `count` pairs of rooms (starting as one per rectangle) by opening up
// the wall between them, where that gives a room with a proper corner: its
// outline steps by NOTCH tiles or more, not a small jog, and isn't just a
// bigger rectangle. Merged rooms have at most `maxArea` floor tiles, smaller
// ones are more likely to be merged, and the hub is never merged.
// Returns each rectangle's group (merged rectangles share one) and the walls opened.
function merge(rng, rects, walls, count, maxArea) {
  const group = rects.map((_, i) => i);
  const size = rects.map(() => 1); // per group: rectangles in it
  const area = rects.map((r) => r.w * r.h); // and floor tiles
  const openings = [];
  const wallsBetween = (ga, gb) => walls.filter((w) =>
    (group[w.a] === ga && group[w.b] === gb) || (group[w.a] === gb && group[w.b] === ga));

  for (let n = 0; n < count; n++) {
    const options = walls.filter((wall) => {
      const ga = group[wall.a];
      const gb = group[wall.b];
      return ga !== gb && ga !== 0 && gb !== 0 &&
        wall.length >= MIN_SIDE &&
        notched(rects[wall.a], rects[wall.b], wall) &&
        size[ga] + size[gb] <= MAX_MERGED &&
        area[ga] + area[gb] + wall.length <= maxArea &&
        wallsBetween(ga, gb).length === 1; // one opening, so no stubs of wall are left inside
    });
    if (!options.length) break;
    const pairs = options.filter((wall) => size[group[wall.a]] === 1 && size[group[wall.b]] === 1);
    const wall = pickBy(rng, pairs.length && rng.next() < PREFER_PAIRS ? pairs : options,
      (w) => area[group[w.a]] + area[group[w.b]], MERGE_JITTER);

    const keep = group[wall.a];
    const gone = group[wall.b];
    for (let i = 0; i < group.length; i++) if (group[i] === gone) group[i] = keep;
    size[keep] += size[gone];
    area[keep] += area[gone] + wall.length;
    openings.push(wall);
  }
  return { group, openings };
}

// Whether joining rectangles p and q through `wall` gives a proper corner.
function notched(p, q, wall) {
  const [start, end] = wall.w === 1 ? ['y', 'h'] : ['x', 'w'];
  const steps = [Math.abs(p[start] - q[start]), Math.abs(p[start] + p[end] - q[start] - q[end])];
  return steps.some((s) => s > 0) && steps.every((s) => s === 0 || s >= NOTCH);
}

// Rooms ({ id, rects }) from the groups, numbered in order of their first
// rectangle, so the hub is room 0. An opened wall becomes a rect of its own.
// Also returns the room id of each rectangle.
function makeRooms(rects, group, openings) {
  const ids = new Map(); // group -> room id
  const roomOf = group.map((g) => {
    if (!ids.has(g)) ids.set(g, ids.size);
    return ids.get(g);
  });
  const rooms = [...ids.values()].map((id) => ({ id, rects: [] }));
  const rect = ({ x, y, w, h }) => ({ x, y, w, h });
  rects.forEach((r, i) => rooms[roomOf[i]].rects.push(rect(r)));
  for (const wall of openings) rooms[roomOf[wall.a]].rects.push(rect(wall));
  return { rooms, roomOf };
}

// Doors between rooms: first along a random spanning tree, so every room can
// be reached, then on a share (`loops`) of the other pairs of neighbours. At
// most one door joins any two rooms, set at least a tile in from either end of
// their shared wall. Null if some room can't be reached.
function connect(rng, rects, walls, roomOf, roomCount, loops) {
  const links = new Map(); // "a,b" -> { a, b, walls }: neighbouring rooms, a < b
  for (const wall of walls) {
    const [a, b] = [roomOf[wall.a], roomOf[wall.b]].sort((x, y) => x - y);
    if (a === b || wall.length < DOOR_SIZE + 2) continue;
    const key = `${a},${b}`;
    if (!links.has(key)) links.set(key, { a, b, walls: [], door: false });
    links.get(key).walls.push(wall);
  }

  const doors = [];
  const addDoor = (link, wall = rng.pick(link.walls)) => {
    const at = rng.int(1, wall.length - 1 - DOOR_SIZE);
    doors.push(wall.w === 1
      ? { id: doors.length, x: wall.x, y: wall.y + at, w: 1, h: DOOR_SIZE, open: false }
      : { id: doors.length, x: wall.x + at, y: wall.y, w: DOOR_SIZE, h: 1, open: false });
    link.door = true;
  };

  const set = Array.from({ length: roomCount }, (_, i) => i);
  const root = (i) => (set[i] === i ? i : (set[i] = root(set[i])));
  const shuffled = shuffle(rng, [...links.values()]);
  for (const link of shuffled) {
    if (root(link.a) === root(link.b)) continue;
    set[root(link.a)] = root(link.b);
    addDoor(link);
  }
  if (doors.length < roomCount - 1) return null;
  for (const link of shuffled) {
    if (!link.door && rng.next() < loops) addDoor(link);
  }

  // Enough of the hub's walls with doors in them. The hub is room 0, so it's always `a`.
  const hub = rects[0];
  const sideOf = (r) =>
    r.w === 1 ? (r.x < hub.x ? 'left' : 'right') : (r.y < hub.y ? 'top' : 'bottom');
  const sides = new Set(doors.filter((d) => touches(hub, d)).map(sideOf));
  while (sides.size < SPAWN_EXITS) {
    const options = shuffled.flatMap((link) => (link.a !== SPAWN_ROOM || link.door ? [] : link.walls
      .filter((wall) => !sides.has(sideOf(wall)))
      .map((wall) => ({ link, wall }))));
    if (!options.length) return null;
    const { link, wall } = rng.pick(options);
    addDoor(link, wall);
    sides.add(sideOf(wall));
  }
  return doors;
}

// Whether a door is set in one of the walls around a rect.
function touches(r, door) {
  const alongX = door.h === 1 && door.x >= r.x && door.x + door.w <= r.x + r.w;
  const alongY = door.w === 1 && door.y >= r.y && door.y + door.h <= r.y + r.h;
  return (alongX && (door.y === r.y - 1 || door.y === r.y + r.h)) ||
    (alongY && (door.x === r.x - 1 || door.x === r.x + r.w));
}

function buildMap({ width, height }, rooms, doors) {
  const tiles = new Uint8Array(width * height).fill(TILE.WALL);
  const fill = ({ x, y, w, h }, tile) => {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) tiles[ty * width + tx] = tile;
    }
  };
  for (const room of rooms) for (const rect of room.rects) fill(rect, TILE.FLOOR);
  for (const door of doors) fill(door, TILE.DOOR);

  const map = { width, height, tiles, rooms, doors, spawnRoom: SPAWN_ROOM };
  map.doorAt = indexDoors(map);
  map.roomAt = indexRooms(map);
  return map;
}

// A solid square of REACTOR tiles in the middle of the hub.
function placeReactor(map) {
  const [hub] = map.rooms[SPAWN_ROOM].rects;
  const reactor = {
    x: hub.x + Math.floor((hub.w - REACTOR_SIZE) / 2),
    y: hub.y + Math.floor((hub.h - REACTOR_SIZE) / 2),
    w: REACTOR_SIZE,
    h: REACTOR_SIZE,
  };
  for (let y = reactor.y; y < reactor.y + reactor.h; y++) {
    for (let x = reactor.x; x < reactor.x + reactor.w; x++) map.tiles[y * map.width + x] = TILE.REACTOR;
  }
  map.reactor = reactor;
}

// Picks the rectangle with room for the extraction zone that's the longest
// walk from spawn, and puts the hatch and zone in the middle of it (on whole
// tiles). Null if even that one is closer than `minRoute`.
function placeExit(map, rects, roomOf, minRoute) {
  // Measured from beside the reactor, where players spawn.
  const { reactor } = map;
  const dist = walkingDistances(map, reactor.x - 1, reactor.y + Math.floor(reactor.h / 2));
  const middle = (size, r) => ({
    x: r.x + Math.floor((r.w - size) / 2),
    y: r.y + Math.floor((r.h - size) / 2),
    w: size,
    h: size,
  });

  let best = null;
  rects.forEach((rect, i) => {
    if (roomOf[i] === SPAWN_ROOM || rect.w < ZONE_SIZE || rect.h < ZONE_SIZE) return;
    const hatch = middle(HATCH_SIZE, rect);
    const route = dist[hatch.y * map.width + hatch.x];
    if (!best || route > best.route) best = { room: roomOf[i], hatch, zone: middle(ZONE_SIZE, rect), route };
  });
  if (!best || best.route < minRoute) return null;
  const { room, hatch, zone } = best;
  return { room, hatch, zone };
}

// Steps from (x, y) to every tile, walking through floor and doors (-1 if unreachable).
function walkingDistances({ width, height, tiles }, x, y) {
  const dist = new Int32Array(width * height).fill(-1);
  const start = y * width + x;
  dist[start] = 0;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const j of [i - 1, i + 1, i - width, i + width]) {
      if (j < 0 || j >= tiles.length || dist[j] >= 0) continue;
      if (tiles[j] !== TILE.FLOOR && tiles[j] !== TILE.DOOR) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// The item with the lowest cost, give or take: each cost is first scaled by a
// random factor within `jitter` of 1, so close calls go either way.
function pickBy(rng, items, cost, jitter) {
  let pick = null;
  let best = Infinity;
  for (const item of items) {
    const score = cost(item) * (1 + (rng.next() * 2 - 1) * jitter);
    if (score < best) [pick, best] = [item, score];
  }
  return pick;
}

function between(rng, [min, max]) {
  return min + rng.next() * (max - min);
}

function shuffle(rng, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
