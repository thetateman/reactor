import { TILE, INTERACT_RANGE } from './constants.js';

// A map is { width, height, tiles, rooms, doors, spawnRoom, doorAt }.
// `tiles` is a flat Uint8Array of TILE values indexed by y * width + x.
// `doors` are { id, x, y, w, h, open } rects in tiles; `doorAt` maps a tile
// index to the id of the door covering it, or -1.

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
  const { width, height, rooms, doors, spawnRoom } = map;
  return { width, height, tiles: Array.from(map.tiles), rooms, doors, spawnRoom };
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
