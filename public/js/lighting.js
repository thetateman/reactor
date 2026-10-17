import { lineOfSight } from '/shared/map.js';
import { conePolygon, visibilityPolygon, withinAngle } from '/shared/vision.js';

// Light and sight, worked out in the browser each frame. The level is dark
// except for:
//   - rooms whose light is on (with their walls), and the hallways when
//     theirs is, as the server reports; these are fully visible from
//     anywhere, line of sight or not
//   - a small soft circle around you, so you're never completely blind
//   - flashlight cones, yours and your teammates'
//   - the glow of the reactor and of the exit hatch
// and of those last three, you only see what's in your own line of sight.

export const LIGHT = {
  ownInner: 0.8, // tiles; fully lit within this of you
  ownOuter: 2.2, // and faded to dark here
  flashRange: 10,
  flashHalfAngle: Math.PI / 6, // a 60 degree cone
  reactorGlow: [2.5, 4.5], // radius when cold and at meltdown
  hatchGlow: 1.6,
  visionRays: 720,
  coneRays: 40,
};

// A light counts as reaching a spot (for exploration and for showing name
// tags and health bars) a bit inside the point where it fades out completely.
const DIM = 0.85;

const roomLookups = new WeakMap();
const hallPaths = new WeakMap();

// Tile index -> id of the room it belongs to, counting the room's walls and
// doors (so a lit room's walls are lit too), or -1.
function roomLookup(map) {
  let lookup = roomLookups.get(map);
  if (!lookup) {
    lookup = new Int16Array(map.width * map.height).fill(-1);
    for (const room of map.rooms) {
      for (let y = room.y - 1; y <= room.y + room.h; y++) {
        for (let x = room.x - 1; x <= room.x + room.w; x++) lookup[y * map.width + x] = room.id;
      }
    }
    roomLookups.set(map, lookup);
  }
  return lookup;
}

// The hallways (every tile outside the rooms and their walls) as one path,
// in tile units, to light them all at once.
function hallPath(map) {
  let path = hallPaths.get(map);
  if (!path) {
    const rooms = roomLookup(map);
    path = new Path2D();
    for (let i = 0; i < rooms.length; i++) {
      if (rooms[i] < 0) path.rect(i % map.width, Math.floor(i / map.width), 1, 1);
    }
    hallPaths.set(map, path);
  }
  return path;
}

// Everything needed to draw this frame's darkness and to test what's visible.
// `eye` is where we are, `aim` where we point (radians), `range` how far to
// look (enough to cover the screen). Others are [{ x, y, aim, flashlight, down }].
// `onSeen(tileIndex)` is called for every lit tile in our line of sight. (Lit
// rooms show on screen from anywhere, but only the parts in our line of sight
// count as seen; the minimap reveals a lit room in full once we've been inside it.)
export function computeScene({ map, lights, hallLights, reactor, flashlightOn }, eye, aim, others, range, onSeen) {
  const rooms = roomLookup(map);
  const litRooms = map.rooms.filter((room) => lights[room.id]);
  const heat = Math.min(1, reactor.temperature / 100);
  const [cold, hot] = LIGHT.reactorGlow;
  const glows = [
    { ...center(map.reactor), radius: cold + (hot - cold) * heat },
    { ...center(map.exit.hatch), radius: LIGHT.hatchGlow },
  ];
  const ownFlashlight = flashlightOn ? { x: eye.x, y: eye.y, aim } : null;

  // Teammates' beams that could reach anything we can see.
  const flashlights = others
    .filter((p) => p.flashlight && !p.down && Math.hypot(p.x - eye.x, p.y - eye.y) < range + LIGHT.flashRange)
    .map((p) => ({
      x: p.x,
      y: p.y,
      aim: p.aim,
      polygon: conePolygon(map, p.x, p.y, p.aim, LIGHT.flashHalfAngle, LIGHT.flashRange, LIGHT.coneRays),
    }));

  const seen = onSeen && ((index, dist, angle) => {
    const lit =
      dist <= LIGHT.ownOuter * DIM ||
      (ownFlashlight && dist <= LIGHT.flashRange * DIM && withinAngle(angle, aim, LIGHT.flashHalfAngle)) ||
      (rooms[index] >= 0 ? lights[rooms[index]] : hallLights) ||
      glows.some((g) => Math.hypot((index % map.width) + 0.5 - g.x, Math.floor(index / map.width) + 0.5 - g.y) <= g.radius);
    if (lit) onSeen(index);
  });
  const vision = visibilityPolygon(map, eye.x, eye.y, range, LIGHT.visionRays, seen);

  return { map, eye, vision, litRooms, hallLights, glows, ownFlashlight, flashlights };
}

// Erases the lit, visible parts of a darkness layer. `ctx` uses the world
// transform (tile units) and 'destination-out' compositing.
export function paintLight(ctx, scene) {
  const { eye } = scene;
  ctx.fillStyle = '#000';
  for (const room of scene.litRooms) ctx.fillRect(room.x - 1, room.y - 1, room.w + 2, room.h + 2);
  if (scene.hallLights) ctx.fill(hallPath(scene.map));

  // Everything else only where we have line of sight.
  ctx.save();
  tracePolygon(ctx, scene.vision);
  ctx.clip();
  for (const g of scene.glows) fillGlow(ctx, g.x, g.y, g.radius * 0.4, g.radius);
  fillGlow(ctx, eye.x, eye.y, LIGHT.ownInner, LIGHT.ownOuter);

  if (scene.ownFlashlight) {
    const { aim } = scene.ownFlashlight;
    ctx.beginPath();
    ctx.moveTo(eye.x, eye.y);
    ctx.arc(eye.x, eye.y, LIGHT.flashRange, aim - LIGHT.flashHalfAngle, aim + LIGHT.flashHalfAngle);
    ctx.closePath();
    ctx.fillStyle = beamGradient(ctx, eye.x, eye.y);
    ctx.fill();
  }

  // A teammate's beam is cut off by walls as seen from them, and we only see
  // the parts of it that are in our own line of sight (the clip above).
  for (const f of scene.flashlights) {
    ctx.save();
    tracePolygon(ctx, f.polygon);
    ctx.clip();
    ctx.fillStyle = beamGradient(ctx, f.x, f.y);
    ctx.fillRect(f.x - LIGHT.flashRange, f.y - LIGHT.flashRange, LIGHT.flashRange * 2, LIGHT.flashRange * 2);
    ctx.restore();
  }
  ctx.restore();
}

// Whether we can see the point: it's in a lit room or lit hallway, or it's
// lit some other way and in our line of sight.
export function canSee(scene, x, y) {
  const { map } = scene;
  const room = roomLookup(map)[Math.floor(y) * map.width + Math.floor(x)];
  if (room >= 0 ? scene.litRooms.some((r) => r.id === room) : scene.hallLights) return true;
  return isLit(scene, x, y) && lineOfSight(scene.map, scene.eye.x, scene.eye.y, x, y);
}

function isLit({ map, eye, glows, ownFlashlight, flashlights }, x, y) {
  const near = (px, py, r) => Math.hypot(x - px, y - py) <= r;
  const inBeam = (f) =>
    near(f.x, f.y, LIGHT.flashRange * DIM) &&
    withinAngle(Math.atan2(y - f.y, x - f.x), f.aim, LIGHT.flashHalfAngle) &&
    lineOfSight(map, f.x, f.y, x, y);
  return (
    near(eye.x, eye.y, LIGHT.ownOuter * DIM) ||
    glows.some((g) => near(g.x, g.y, g.radius)) ||
    (ownFlashlight && inBeam(ownFlashlight)) ||
    flashlights.some(inBeam)
  );
}

function center(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function tracePolygon(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
}

// A soft circle of light: full strength out to `inner`, gone at `outer`.
function fillGlow(ctx, x, y, inner, outer) {
  const gradient = ctx.createRadialGradient(x, y, inner, x, y, outer);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fill();
}

// Bright for most of its reach, fading out toward the end.
function beamGradient(ctx, x, y) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, LIGHT.flashRange);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
  gradient.addColorStop(0.6, 'rgba(0, 0, 0, 1)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  return gradient;
}
