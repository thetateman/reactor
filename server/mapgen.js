import { TILE } from '../shared/constants.js';
import { indexDoors } from '../shared/map.js';
import { createRng } from './rng.js';

// Procedural maze levels. The map is a grid of cells: each cell is a 2x2-tile
// passage, with 1-tile walls between neighbouring cells.
//   1. Mark out rooms in whole cells: a large spawn hub in the middle and a few
//      chambers, some of them 3x3 cells in the outer part of the map where the
//      exit can go. Rooms never touch each other.
//   2. Carve a maze through the cells with a randomized depth-first search,
//      treating each room as a single cell that can be entered from any side.
//      Openings into a room become doors.
//   3. Open some dead ends into loops ("braiding"), and make sure the hub has
//      exits on at least two walls.
//   4. Put the exit hatch, inside its extraction zone, in the outer chamber
//      that's the longest walk from spawn.

// Level 1: about five minutes for a group exploring without a map.
const LEVEL = {
  cellsW: 27,
  cellsH: 21,
  braid: 0.35, // chance each dead end is opened into a loop
  chambers: 12,
  exitChambers: 3, // how many of those must be in the outer part of the map
  minExitRoute: 120, // tiles walked from the middle of the hub to the hatch
};

const CELL = 3; // tiles per cell: 2 of passage, 1 of wall
const HUB_W = 6; // cells
const HUB_H = 4;
const CHAMBER_SIZE = [3, 4]; // cells per side, so 8 to 11 tiles inside
const SPAWN_ROOM = 0; // room id of the hub
const SPAWN_EXITS = 2; // the hub has doors on at least this many walls
const OUTER = 0.3; // the exit is at least this far from the middle, as a fraction of the map size
const HATCH_SIZE = 2; // tiles
const ZONE_SIZE = 6; // tiles; fits inside the smallest chamber

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up, right, down, left

export function generateMap(seed) {
  const rng = createRng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const map = tryGenerate(rng, LEVEL);
    if (map) return map;
  }
  throw new Error(`could not generate a map for seed ${seed}`);
}

function tryGenerate(rng, level) {
  const grid = createGrid(level);
  const rooms = placeRooms(rng, grid, level);
  if (!rooms) return null;
  for (const room of rooms) {
    for (const c of roomCells(grid, room)) grid.roomAt[c] = room.id;
  }

  carveMaze(rng, grid, rooms);
  braid(rng, grid, level.braid);
  ensureHubExits(rng, grid, rooms[SPAWN_ROOM]);

  const map = buildMap(grid, rooms);
  const exit = placeExit(map, rooms, level.minExitRoute);
  if (!exit) return null;
  map.exit = exit;
  return map;
}

// Cells are indexed y * w + x. `open[cell * 4 + dir]` is set when the wall
// between that cell and its neighbour in `dir` has been knocked through.
function createGrid({ cellsW, cellsH }) {
  return {
    w: cellsW,
    h: cellsH,
    roomAt: new Int16Array(cellsW * cellsH).fill(-1),
    open: new Uint8Array(cellsW * cellsH * 4),
  };
}

function neighbor(grid, c, dir) {
  const x = (c % grid.w) + DIRS[dir][0];
  const y = Math.floor(c / grid.w) + DIRS[dir][1];
  return x < 0 || y < 0 || x >= grid.w || y >= grid.h ? -1 : y * grid.w + x;
}

function link(grid, c, dir) {
  grid.open[c * 4 + dir] = 1;
  grid.open[neighbor(grid, c, dir) * 4 + ((dir + 2) % 4)] = 1;
}

function roomCells(grid, room) {
  const cells = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) cells.push(y * grid.w + x);
  }
  return cells;
}

// Rooms in cell units. Returns null if the exit chambers didn't all fit.
function placeRooms(rng, grid, level) {
  const rooms = [{
    id: SPAWN_ROOM,
    x: Math.floor((grid.w - HUB_W) / 2),
    y: Math.floor((grid.h - HUB_H) / 2),
    w: HUB_W,
    h: HUB_H,
  }];
  // At least one cell of passage between any two rooms.
  const fits = (r) =>
    r.x >= 0 && r.y >= 0 && r.x + r.w <= grid.w && r.y + r.h <= grid.h &&
    rooms.every((o) => r.x + r.w < o.x || o.x + o.w < r.x || r.y + r.h < o.y || o.y + o.h < r.y);
  const isOuter = (r) => Math.max(
    Math.abs(r.x + r.w / 2 - grid.w / 2) / grid.w,
    Math.abs(r.y + r.h / 2 - grid.h / 2) / grid.h,
  ) > OUTER;

  // The first few chambers must be in the outer part, so there's always somewhere far out for the exit.
  for (let tries = 0; tries < 5000 && rooms.length <= level.chambers; tries++) {
    const w = rng.int(...CHAMBER_SIZE);
    const h = rng.int(...CHAMBER_SIZE);
    const room = { id: rooms.length, x: rng.int(0, grid.w - w), y: rng.int(0, grid.h - h), w, h };
    room.outer = isOuter(room);
    if (fits(room) && (room.outer || rooms.length > level.exitChambers)) rooms.push(room);
  }
  return rooms.length > level.exitChambers ? rooms : null;
}

// Randomized depth-first search from the hub. Entering a room visits all of
// its cells at once, so the maze can leave the room from any side.
function carveMaze(rng, grid, rooms) {
  const visited = new Uint8Array(grid.w * grid.h);
  const stack = [];
  const enter = (c) => {
    const room = grid.roomAt[c];
    const cells = room < 0 ? [c] : shuffle(rng, roomCells(grid, rooms[room]));
    for (const cell of cells) visited[cell] = 1;
    stack.push(...cells);
  };

  const hub = rooms[SPAWN_ROOM];
  enter(hub.y * grid.w + hub.x);
  while (stack.length) {
    const c = stack[stack.length - 1];
    const dirs = [0, 1, 2, 3].filter((d) => {
      const n = neighbor(grid, c, d);
      return n >= 0 && !visited[n];
    });
    if (!dirs.length) {
      stack.pop();
      continue;
    }
    const dir = rng.pick(dirs);
    link(grid, c, dir);
    enter(neighbor(grid, c, dir));
  }
}

// Gives each passage dead end a `chance` of being opened into a neighbour.
function braid(rng, grid, chance) {
  for (let c = 0; c < grid.w * grid.h; c++) {
    if (grid.roomAt[c] >= 0 || openings(grid, c).length !== 1 || rng.next() >= chance) continue;
    const closed = [0, 1, 2, 3].filter((d) => !grid.open[c * 4 + d] && neighbor(grid, c, d) >= 0);
    if (closed.length) link(grid, c, rng.pick(closed));
  }
}

function openings(grid, c) {
  return [0, 1, 2, 3].filter((d) => grid.open[c * 4 + d]);
}

// Which walls of a room have openings, as a set of directions.
function roomExitWalls(grid, room) {
  const walls = new Set();
  for (const c of roomCells(grid, room)) {
    for (const d of openings(grid, c)) {
      if (grid.roomAt[neighbor(grid, c, d)] !== room.id) walls.add(d);
    }
  }
  return walls;
}

function ensureHubExits(rng, grid, hub) {
  for (let walls = roomExitWalls(grid, hub); walls.size < SPAWN_EXITS; walls = roomExitWalls(grid, hub)) {
    const dir = rng.pick([0, 1, 2, 3].filter((d) => !walls.has(d)));
    const edge = roomCells(grid, hub).filter((c) => {
      const n = neighbor(grid, c, dir);
      return n >= 0 && grid.roomAt[n] < 0;
    });
    link(grid, rng.pick(edge), dir);
  }
}

// Turns the cell grid into tiles. Rooms are given in tile units, as the floor
// rect inside their walls.
function buildMap(grid, rooms) {
  const width = grid.w * CELL + 1;
  const height = grid.h * CELL + 1;
  const tiles = new Uint8Array(width * height).fill(TILE.WALL);
  const fill = (x0, y0, w, h, tile) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) tiles[y * width + x] = tile;
    }
  };

  for (let c = 0; c < grid.w * grid.h; c++) {
    const x = (c % grid.w) * CELL + 1;
    const y = Math.floor(c / grid.w) * CELL + 1;
    fill(x, y, 2, 2, TILE.FLOOR);
    // Knock through to the right and below; the other two sides are handled by those neighbours.
    for (const dir of [1, 2]) {
      if (!grid.open[c * 4 + dir]) continue;
      const n = neighbor(grid, c, dir);
      const tile = grid.roomAt[c] === grid.roomAt[n] ? TILE.FLOOR : TILE.DOOR;
      if (dir === 1) fill(x + 2, y, 1, 2, tile);
      else fill(x, y + 2, 2, 1, tile);
    }
  }

  const tileRooms = rooms.map((r) => ({
    id: r.id,
    x: r.x * CELL + 1,
    y: r.y * CELL + 1,
    w: r.w * CELL - 1,
    h: r.h * CELL - 1,
  }));
  for (const r of tileRooms) fill(r.x, r.y, r.w, r.h, TILE.FLOOR);

  const map = { width, height, tiles, rooms: tileRooms, doors: [], spawnRoom: SPAWN_ROOM };
  map.doors = findDoors(map);
  map.doorAt = indexDoors(map);
  return map;
}

// Picks the chamber in the outer part of the map that's the longest walk
// from the hub, and puts the hatch and extraction zone in the middle of it
// (on whole tiles). Null if even that one is closer than `minRoute`.
function placeExit(map, cellRooms, minRoute) {
  const hub = map.rooms[SPAWN_ROOM];
  const dist = walkingDistances(map, Math.floor(hub.x + hub.w / 2), Math.floor(hub.y + hub.h / 2));
  const middle = (size, room) => ({
    x: room.x + Math.floor((room.w - size) / 2),
    y: room.y + Math.floor((room.h - size) / 2),
    w: size,
    h: size,
  });

  let best = null;
  for (const cellRoom of cellRooms) {
    if (cellRoom.id === SPAWN_ROOM || !cellRoom.outer) continue;
    const room = map.rooms[cellRoom.id];
    const hatch = middle(HATCH_SIZE, room);
    const route = dist[hatch.y * map.width + hatch.x];
    if (!best || route > best.route) best = { room: room.id, hatch, zone: middle(ZONE_SIZE, room), route };
  }
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
      if (j < 0 || j >= tiles.length || dist[j] >= 0 || tiles[j] === TILE.WALL) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// Door tiles always lie in a straight run along one wall, so each connected
// run becomes one door rect.
function findDoors({ width, height, tiles }) {
  const doors = [];
  const seen = new Uint8Array(tiles.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (tiles[i] !== TILE.DOOR || seen[i]) continue;

      let w = 1;
      while (x + w < width && tiles[i + w] === TILE.DOOR) w++;
      let h = 1;
      if (w === 1) {
        while (y + h < height && tiles[i + h * width] === TILE.DOOR) h++;
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) seen[i + dy * width + dx] = 1;
      }
      doors.push({ id: doors.length, x, y, w, h, open: false });
    }
  }
  return doors;
}

function shuffle(rng, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
