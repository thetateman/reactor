import { isSolid } from './map.js';

// Line-of-sight geometry for lighting and exploration. Everything that stops
// movement (walls, closed doors, the reactor) also stops sight.

// How far rays reach into the tile that stops them, so the face of a wall
// that's being looked at counts as seen. Less than half a tile, so a ray
// clipping a wall's corner doesn't peek into the passage behind it.
export const WALL_PEEK = 0.3;

// Walks a ray from (x, y) along the unit direction (dx, dy) for up to
// `maxDist`, calling visit(tileIndex, dist) for each tile it passes through
// (starting with its own), where `dist` is how far along the ray it entered
// that tile. Stops at the first solid tile, after visiting it. Returns the
// distance to that tile's edge, or `maxDist` if nothing was hit.
export function walkRay(map, x, y, dx, dy, maxDist, visit) {
  let tx = Math.floor(x);
  let ty = Math.floor(y);
  visit?.(ty * map.width + tx, 0);
  if (isSolid(map, tx, ty)) return 0;

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
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
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return dist;
    visit?.(ty * map.width + tx, dist);
    if (isSolid(map, tx, ty)) return dist;
  }
}

// Casts `rays` evenly spaced rays from (x, y) out to `range`, each stopping
// WALL_PEEK into the first solid tile. Returns the end points as a flat
// [x0, y0, x1, y1, ...] array: the outline of what can be seen from there.
// `visit(tileIndex, dist, angle)` is called for every tile the rays cross.
export function visibilityPolygon(map, x, y, range, rays, visit) {
  return fan(map, x, y, 0, Math.PI * 2, range, rays, visit, false);
}

// The same over the arc from `angle - halfWidth` to `angle + halfWidth`, with
// (x, y) as the first point: a cone of light cut off by walls.
export function conePolygon(map, x, y, angle, halfWidth, range, rays) {
  return fan(map, x, y, angle - halfWidth, halfWidth * 2, range, rays, null, true);
}

function fan(map, x, y, start, sweep, range, rays, visit, withOrigin) {
  const closed = sweep >= Math.PI * 2;
  const count = closed ? rays : rays + 1;
  const points = new Float64Array((count + (withOrigin ? 1 : 0)) * 2);
  let n = 0;
  if (withOrigin) {
    points[n++] = x;
    points[n++] = y;
  }
  for (let i = 0; i < count; i++) {
    const angle = start + (sweep * i) / rays;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const onTile = visit && ((index, dist) => visit(index, dist, angle));
    const hit = walkRay(map, x, y, dx, dy, range, onTile);
    const reach = hit < range ? Math.min(hit + WALL_PEEK, range) : range;
    points[n++] = x + dx * reach;
    points[n++] = y + dy * reach;
  }
  return points;
}

// Whether `angle` is within `halfWidth` of `center` (radians, any winding).
export function withinAngle(angle, center, halfWidth) {
  const diff = Math.abs(((angle - center + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
  return diff <= halfWidth;
}
