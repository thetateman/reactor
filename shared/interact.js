import { PICKUP_RANGE, PLAYER_MAX_AMMO } from './constants.js';
import { nearestDoor } from './map.js';

// What pressing E does for a player at `body` ({ x, y }) carrying `ammo`
// rounds, in order of priority:
//   { kind: 'hatch' }         standing on the exit hatch: escape
//   { kind: 'pickup', item }  an item in reach that they can use
//   { kind: 'door', door }    the nearest door in reach: open or close it
// or null. Shared so the prompt the client shows matches what the server does.
export function interactionTarget(map, pickups, body, ammo) {
  if (map.exit && pointInRect(body, map.exit.hatch)) return { kind: 'hatch' };
  const item = nearestPickup(pickups, body);
  if (item && canTake(item, ammo)) return { kind: 'pickup', item };
  const door = nearestDoor(map, body.x, body.y);
  return door ? { kind: 'door', door } : null;
}

// The closest pickup within reach of `body`, or null.
export function nearestPickup(pickups, body) {
  let best = null;
  let bestDist = PICKUP_RANGE;
  for (const item of pickups) {
    const dist = Math.hypot(item.x - body.x, item.y - body.y);
    if (dist <= bestDist) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

export function canTake(item, ammo) {
  return item.kind === 'ammo' && ammo < PLAYER_MAX_AMMO;
}

export function pointInRect(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;
}
