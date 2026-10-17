import { TILE, INTERACT_RANGE } from './constants.js';

// A map is { width, height, tiles, rooms, doors, spawnRoom, exit, doorAt }.
// `tiles` is a flat Uint8Array of TILE values indexed by y * width + x.
// `rooms` are { id, x, y, w, h } floor rects in tiles.
// `doors` are { id, x, y, w, h, open } rects in tiles; `doorAt` maps a tile
// index to the id of the door covering it, or -1.
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

export function serializeMap(map) {
  const { width, height, rooms, doors, spawnRoom, exit } = map;
  return { width, height, tiles: Array.from(map.tiles), rooms, doors, spawnRoom, exit };
}

export function deserializeMap(data) {
  const map = { ...data, tiles: Uint8Array.from(data.tiles) };
  map.doorAt = indexDoors(map);
  return map;
}

export function roomCenter(room) {
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
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

// The closest door whose rect is within reach of the point, or null.
export function nearestDoor(map, x, y, range = INTERACT_RANGE) {
  let best = null;
  let bestDist = range;
  for (const door of map.doors) {
    const dx = Math.max(door.x - x, 0, x - (door.x + door.w));
    const dy = Math.max(door.y - y, 0, y - (door.y + door.h));
    const dist = Math.hypot(dx, dy);
    if (dist <= bestDist) {
      best = door;
      bestDist = dist;
    }
  }
  return best;
}
