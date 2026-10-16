import { TILE } from '../shared/constants.js';
import { indexDoors } from '../shared/map.js';
import { createRng } from './rng.js';

// Procedural reactor layout:
//   1. Scatter randomly sized rooms with a minimum gap between them.
//   2. Link them with a minimum spanning tree, plus a few extra links for loops.
//   3. Route a corridor for each link with A*. Corridors may not touch other
//      rooms; where one crosses its own rooms' walls, that opening becomes a door.
//   4. Wrap every walkable tile in walls and crop to the used area.

const MAP_W = 84;
const MAP_H = 64;
const ROOM_COUNT = 12;
const ROOM_MIN_W = 5;
const ROOM_MAX_W = 16;
const ROOM_MIN_H = 5;
const ROOM_MAX_H = 12;
const ROOM_GAP = 5; // between room floors: wall + corridor + wall must fit
const EXTRA_LINKS = 3;
const CORRIDOR_WIDTH = 2;

// A* step costs. Turns are penalised so corridors run in long straight lines.
const COST_REUSE = 1; // room floor or an existing corridor
const COST_OPEN = 2;
const COST_WALL = 12; // crossing a wall of the two rooms being linked
const COST_TURN = 4;

export function generateMap(seed) {
  const rng = createRng(seed);
  for (let attempt = 0; attempt < 20; attempt++) {
    const map = tryGenerate(rng);
    if (map) return map;
  }
  throw new Error(`could not generate a map for seed ${seed}`);
}

function tryGenerate(rng) {
  const rooms = placeRooms(rng);
  if (rooms.length < ROOM_COUNT) return null;

  const grid = createGrid(rooms);
  for (const [a, b] of linkRooms(rooms, rng)) {
    if (!carveCorridor(grid, rooms[a], rooms[b])) return null;
  }

  const tiles = buildTiles(grid);
  return finishMap(tiles, rooms, rng);
}

function placeRooms(rng) {
  const rooms = [];
  for (let tries = 0; tries < 3000 && rooms.length < ROOM_COUNT; tries++) {
    const w = rng.int(ROOM_MIN_W, ROOM_MAX_W);
    const h = rng.int(ROOM_MIN_H, ROOM_MAX_H);
    // Leave a tile for the room's wall and one for the corridor margin.
    const room = {
      id: rooms.length,
      x: rng.int(2, MAP_W - w - 2),
      y: rng.int(2, MAP_H - h - 2),
      w,
      h,
    };
    if (rooms.every((other) => !rectsNear(room, other, ROOM_GAP))) rooms.push(room);
  }
  return rooms;
}

function rectsNear(a, b, gap) {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

// Returns [roomIndexA, roomIndexB] pairs: a minimum spanning tree over room
// centers (Prim's), then a few of the shortest remaining pairs to add loops.
function linkRooms(rooms, rng) {
  const dist = (a, b) => Math.hypot(
    a.x + a.w / 2 - (b.x + b.w / 2),
    a.y + a.h / 2 - (b.y + b.h / 2),
  );

  const links = [];
  const inTree = new Set([0]);
  while (inTree.size < rooms.length) {
    let best = null;
    for (const i of inTree) {
      for (let j = 0; j < rooms.length; j++) {
        if (inTree.has(j)) continue;
        const d = dist(rooms[i], rooms[j]);
        if (!best || d < best.d) best = { i, j, d };
      }
    }
    inTree.add(best.j);
    links.push([best.i, best.j]);
  }

  const linked = new Set(links.map(([a, b]) => `${Math.min(a, b)},${Math.max(a, b)}`));
  const candidates = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (!linked.has(`${i},${j}`)) candidates.push({ i, j, d: dist(rooms[i], rooms[j]) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  const shortlist = candidates.slice(0, EXTRA_LINKS * 3);
  for (let n = 0; n < EXTRA_LINKS && shortlist.length; n++) {
    const { i, j } = shortlist.splice(rng.int(0, shortlist.length - 1), 1)[0];
    links.push([i, j]);
  }

  return links;
}

// Working state while carving: which room's floor or wall each tile belongs to.
function createGrid(rooms) {
  const size = MAP_W * MAP_H;
  const grid = {
    floor: new Int16Array(size).fill(-1), // room id whose floor covers the tile
    wall: new Int16Array(size).fill(-1), // room id whose surrounding wall covers the tile
    corner: new Uint8Array(size), // wall corners can never become doors
    corridor: new Uint8Array(size),
  };

  for (const room of rooms) {
    for (let y = room.y - 1; y <= room.y + room.h; y++) {
      for (let x = room.x - 1; x <= room.x + room.w; x++) {
        const i = y * MAP_W + x;
        const edgeX = x === room.x - 1 || x === room.x + room.w;
        const edgeY = y === room.y - 1 || y === room.y + room.h;
        if (edgeX || edgeY) {
          grid.wall[i] = room.id;
          grid.corner[i] = edgeX && edgeY ? 1 : 0;
        } else {
          grid.floor[i] = room.id;
        }
      }
    }
  }
  return grid;
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// A* from room a to room b. Each search node is the top-left tile of a
// CORRIDOR_WIDTH square plus the direction it was entered from (for turn costs).
function carveCorridor(grid, a, b) {
  const W = MAP_W;
  const cw = CORRIDOR_WIDTH;

  const startX = a.x + Math.floor((a.w - cw) / 2);
  const startY = a.y + Math.floor((a.h - cw) / 2);
  const goal = { x0: b.x, x1: b.x + b.w - cw, y0: b.y, y1: b.y + b.h - cw };
  const heuristic = (x, y) =>
    Math.max(goal.x0 - x, 0, x - goal.x1) + Math.max(goal.y0 - y, 0, y - goal.y1);

  const stepCost = (x, y) => {
    let cost = COST_REUSE;
    for (let ty = y; ty < y + cw; ty++) {
      for (let tx = x; tx < x + cw; tx++) {
        if (tx < 1 || ty < 1 || tx > MAP_W - 2 || ty > MAP_H - 2) return Infinity;
        const i = ty * W + tx;
        const floor = grid.floor[i];
        if (floor >= 0) {
          if (floor !== a.id && floor !== b.id) return Infinity;
          continue;
        }
        const wall = grid.wall[i];
        if (wall >= 0) {
          if ((wall !== a.id && wall !== b.id) || grid.corner[i]) return Infinity;
          if (!grid.corridor[i]) cost = Math.max(cost, COST_WALL); // reuse existing doors
          continue;
        }
        if (!grid.corridor[i]) cost = Math.max(cost, COST_OPEN);
      }
    }
    return cost;
  };

  const g = new Float64Array(MAP_W * MAP_H * 4).fill(Infinity);
  const from = new Int32Array(MAP_W * MAP_H * 4).fill(-1);
  const open = new MinHeap();
  for (let dir = 0; dir < 4; dir++) {
    const s = (startY * W + startX) * 4 + dir;
    g[s] = 0;
    open.push(heuristic(startX, startY), s);
  }

  while (open.size) {
    const s = open.pop();
    const cell = s >> 2;
    const dir = s & 3;
    const x = cell % W;
    const y = (cell - x) / W;

    if (x >= goal.x0 && x <= goal.x1 && y >= goal.y0 && y <= goal.y1) {
      for (let at = s; at !== -1; at = from[at]) carveSquare(grid, at >> 2);
      return true;
    }

    for (let nd = 0; nd < 4; nd++) {
      if (nd === (dir + 2) % 4) continue;
      const nx = x + DIRS[nd][0];
      const ny = y + DIRS[nd][1];
      const cost = stepCost(nx, ny);
      if (cost === Infinity) continue;
      const ng = g[s] + cost + (nd === dir ? 0 : COST_TURN);
      const ns = (ny * W + nx) * 4 + nd;
      if (ng < g[ns]) {
        g[ns] = ng;
        from[ns] = s;
        open.push(ng + heuristic(nx, ny), ns);
      }
    }
  }
  return false;
}

function carveSquare(grid, cell) {
  const x = cell % MAP_W;
  const y = (cell - x) / MAP_W;
  for (let ty = y; ty < y + CORRIDOR_WIDTH; ty++) {
    for (let tx = x; tx < x + CORRIDOR_WIDTH; tx++) {
      const i = ty * MAP_W + tx;
      if (grid.floor[i] < 0) grid.corridor[i] = 1;
    }
  }
}

function buildTiles(grid) {
  const tiles = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < tiles.length; i++) {
    if (grid.floor[i] >= 0) tiles[i] = TILE.FLOOR;
    else if (grid.corridor[i]) tiles[i] = grid.wall[i] >= 0 ? TILE.DOOR : TILE.FLOOR;
  }

  // Any empty tile touching a walkable one (including diagonally) becomes wall.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] !== TILE.VOID) continue;
      if (touchesWalkable(tiles, x, y)) tiles[y * MAP_W + x] = TILE.WALL;
    }
  }
  return tiles;
}

function touchesWalkable(tiles, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const tile = tiles[ny * MAP_W + nx];
      if (tile === TILE.FLOOR || tile === TILE.DOOR) return true;
    }
  }
  return false;
}

// Crops to the used area, groups door tiles into door rects and picks a spawn.
function finishMap(tiles, rooms, rng) {
  let minX = MAP_W, minY = MAP_H, maxX = 0, maxY = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] === TILE.VOID) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cropped[y * width + x] = tiles[(y + minY) * MAP_W + (x + minX)];
    }
  }

  const map = {
    width,
    height,
    tiles: cropped,
    rooms: rooms.map((r) => ({ ...r, x: r.x - minX, y: r.y - minY })),
    doors: [],
  };
  map.doors = findDoors(map);
  map.doorAt = indexDoors(map);

  const room = rng.pick(map.rooms);
  map.spawn = { x: room.x + room.w / 2, y: room.y + room.h / 2 };
  return map;
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

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}
