import { TILE, INTERACT_RANGE } from './constants.js';

// A map is { width, height, tiles, rooms, doors, spawnRoom, reactor, exit, doorAt, roomAt }.
// `tiles` is a flat Uint8Array of TILE values indexed by y * width + x.
// `rooms` are { id, rects }: the room's floor as one or more { x, y, w, h }
// rects in tiles, which together make up its shape (an L-shaped room is two or
// three). Every walkable tile is in a room, apart from doors; there are no
// hallways. Neighbouring rooms share the 1-tile wall between them, and doors
// are set in those walls. `roomAt` maps a tile index to the id of the room
// whose rects cover it, or -1 for walls and doors.
// The spawn room is a single rect, with the reactor in its middle.
// `doors` are { id, x, y, w, h, open } rects in tiles; `doorAt` maps a tile
// index to the id of the door covering it, or -1.
// `reactor` is the { x, y, w, h } rect of REACTOR tiles in the middle of the spawn room.
// `exit` is { room, hatch, zone }: the hatch and extraction zone rects, in room `room`.

export function indexDoors(map) {
  const doorAt = new Int16Array(map.width * map.height).fill(-1);
  for (const door of map.doors) {
    for (let y = door.y; y < door.y + door.h; y++) {
      for (let x = door.x; x < door.x + door.w; x++) {
        doorAt[y * map.width + x] = door.id;
      }
    }
  }
  return doorAt;
}

export function indexRooms(map) {
  const roomAt = new Int16Array(map.width * map.height).fill(-1);
  for (const room of map.rooms) {
    for (const rect of room.rects) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) roomAt[y * map.width + x] = room.id;
      }
    }
  }
  return roomAt;
}

export function serializeMap(map) {
  const { width, height, rooms, doors, spawnRoom, reactor, exit } = map;
  return { width, height, tiles: Array.from(map.tiles), rooms, doors, spawnRoom, reactor, exit };
}

export function deserializeMap(data) {
  const map = { ...data, tiles: Uint8Array.from(data.tiles) };
  map.doorAt = indexDoors(map);
  map.roomAt = indexRooms(map);
  return map;
}

// Id of the room the point is in, or -1 in a wall or doorway (or off the map).
export function roomOf(map, x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return -1;
  return map.roomAt[ty * map.width + tx];
}

export function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return TILE.VOID;
  return map.tiles[y * map.width + x];
}

export function isSolid(map, x, y) {
  const tile = tileAt(map, x, y);
  if (tile === TILE.FLOOR) return false;
  if (tile === TILE.DOOR) return !map.doors[map.doorAt[y * map.width + x]].open;
  return true;
}

// Distance from (x, y) along the unit direction (dx, dy) to the first wall or
// closed door, or `maxDist` if there's none within it. Walks the tiles the
// ray passes through, one tile edge at a time.
export function castRay(map, x, y, dx, dy, maxDist) {
  let tx = Math.floor(x);
  let ty = Math.floor(y);
  if (isSolid(map, tx, ty)) return 0; // starting exactly on a wall's edge
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  // Ray length to cross one whole tile, and to reach the next tile edge, per axis.
  const deltaX = stepX ? 1 / Math.abs(dx) : Infinity;
  const deltaY = stepY ? 1 / Math.abs(dy) : Infinity;
  let nextX = stepX > 0 ? (tx + 1 - x) * deltaX : stepX < 0 ? (x - tx) * deltaX : Infinity;
  let nextY = stepY > 0 ? (ty + 1 - y) * deltaY : stepY < 0 ? (y - ty) * deltaY : Infinity;

  for (;;) {
    let dist;
    if (nextX < nextY) {
      dist = nextX;
      nextX += deltaX;
      tx += stepX;
    } else {
      dist = nextY;
      nextY += deltaY;
      ty += stepY;
    }
    if (dist >= maxDist) return maxDist;
    if (isSolid(map, tx, ty)) return dist;
  }
}

// Whether a straight line between two points crosses only open tiles.
export function lineOfSight(map, x0, y0, x1, y1) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len === 0) return true;
  return castRay(map, x0, y0, (x1 - x0) / len, (y1 - y0) / len, len) >= len;
}

// Distance from a point to the nearest edge of a rect (0 if it's inside).
export function distanceToRect(x, y, rect) {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

// The closest door whose rect is within reach of the point, or null.
export function nearestDoor(map, x, y, range = INTERACT_RANGE) {
  let best = null;
  let bestDist = range;
  for (const door of map.doors) {
    const dist = distanceToRect(x, y, door);
    if (dist <= bestDist) {
      best = door;
      bestDist = dist;
    }
  }
  return best;
}
