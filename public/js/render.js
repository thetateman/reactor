import {
  ENEMY_MAX_HP, ENEMY_RADIUS, PICKUP_SIZE, PLAYER_MAX_HP, PLAYER_SIZE, REACTOR_OVERHEAT_MIN, REACTOR_POWER_MIN,
  TILE,
} from '/shared/constants.js';
import { canTake, nearestPickup, pointInRect } from '/shared/interact.js';
import { canSee, computeScene, paintLight } from './lighting.js';
import { Minimap } from './minimap.js';

const TILE_PX = 32; // CSS pixels per tile in the main view
const FULL_MAP_PX = 3; // CSS pixels per tile in the full map (Shift+M)
const MARGIN = 16;
const WALL_EDGE = 0.12; // lit strip along wall faces, in tiles
const HEALTH_BAR = { w: 30, h: 4 }; // CSS pixels
const ENEMY_HEALTH_BAR = { w: 20, h: 3 };
const HURT_FLASH_MS = 300;
const BULLET_RADIUS = 0.08; // tiles
const BULLET_TRAIL = 0.6; // tiles
const DIAL_RADIUS = 26; // CSS pixels, the dial over the reactor

const COLORS = {
  void: '#07090c',
  dark: '#020305', // what's neither lit nor in sight
  corridor: '#151a21',
  room: '#1b222c',
  grid: 'rgba(255, 255, 255, 0.04)',
  wall: '#2b333e',
  wallEdge: '#4a5667',
  door: '#c99a2e',
  doorSeam: '#6b4f12',
  doorOpen: 'rgba(201, 154, 46, 0.18)',
  player: '#8b949e', // fallback when a player isn't in the roster
  playerEdge: 'rgba(0, 0, 0, 0.45)',
  downed: '#484f58',
  enemy: '#f85149',
  enemyEdge: 'rgba(0, 0, 0, 0.5)',
  hpHigh: '#3fb950',
  hpMid: '#d29922',
  hpLow: '#f85149',
  hpTrack: 'rgba(7, 9, 12, 0.85)',
  hurt: '248, 81, 73', // rgb, for the damage vignette
  bullet: '#ffd33d',
  bulletTrail: 'rgba(255, 211, 61, 0.35)',
  exit: '#56d364',
  exitDark: '#1a4d24',
  exitGlow: '86, 211, 100', // rgb, for the hatch glow and extraction zone
  reactor: '#1f6feb',
  reactorCore: '#79c0ff',
  reactorEdge: '#0d2d6b',
  reactorGlow: '88, 166, 255', // rgb
  dialCold: '#388bfd',
  dialStable: '#3fb950',
  dialHot: '#f85149',
  highlight: '#f0f6fc',
  panel: 'rgba(7, 9, 12, 0.75)',
  miniRoom: '#3a4554',
  miniCorridor: '#2c3541',
  miniWall: '#5c6878',
};
const AWAY_ALPHA = 0.35; // disconnected players are drawn faded

// Pickup sprites by kind. Drawn once loaded; until then, nothing.
const SPRITES = {
  ammo: loadImage('/assets/bullet-stack.png'),
};

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let layers = null;
  let minimap = null;
  let view = null; // camera of the last frame drawn, for mapping clicks to the world
  // Darkness is drawn here first, with the lit parts cut out, then laid over the world.
  const dark = document.createElement('canvas');
  const dctx = dark.getContext('2d');

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = dark.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = dark.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  return {
    // `gameId` identifies the level, so the minimap can restore what we'd explored.
    setMap(map, gameId) {
      layers = buildLayers(map);
      minimap = new Minimap(map, gameId);
    },

    clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COLORS.void;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },

    // The world point (in tiles) under a viewport position, as drawn last frame.
    screenToWorld(clientX, clientY) {
      if (!view) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.w / 2) / TILE_PX + view.cam.x,
        y: (clientY - rect.top - view.h / 2) / TILE_PX + view.cam.y,
      };
    },

    // `roster` maps player id to { name, color, connected } from the lobby.
    // `alpha` blends our own position between movement steps; `now` places
    // other players and enemies on their interpolation timeline. `aim` is
    // where we point our flashlight. `showMinimap` shows our explored map;
    // `fullMap` instead shows the whole level, for testing. `showDial` shows
    // the temperature dial on the reactor.
    draw(game, roster, alpha, now, { aim = 0, showMinimap = true, fullMap = false, showDial = true } = {}) {
      const { map } = game;
      const self = { id: game.you, ...game.selfAt(alpha), hp: game.hp, down: game.down };
      const players = [...game.othersAt(now), self].map((p) => ({
        ...p,
        name: roster.get(p.id)?.name ?? '',
        color: roster.get(p.id)?.color ?? COLORS.player,
        away: roster.get(p.id)?.connected === false,
      }));
      const enemies = game.enemiesAt(now);
      const viewW = canvas.width / dpr;
      const viewH = canvas.height / dpr;
      const cam = {
        x: follow(self.x, map.width, viewW / TILE_PX),
        y: follow(self.y, map.height, viewH / TILE_PX),
      };
      const toScreen = (x, y) => ({
        x: (x - cam.x) * TILE_PX + viewW / 2,
        y: (y - cam.y) * TILE_PX + viewH / 2,
      });
      view = { cam, w: viewW, h: viewH };

      // What's lit and in sight, looking far enough to reach every screen corner.
      const others = players.filter((p) => p.id !== game.you);
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) =>
        Math.hypot(cam.x + (sx * viewW) / TILE_PX / 2 - self.x, cam.y + (sy * viewH) / TILE_PX / 2 - self.y));
      const scene = computeScene(game, self, aim, others, Math.max(...corners) + 1, (i) => minimap.reveal(i));
      minimap.visit(self, game.lights);

      this.clear();

      // World pass, in tile units.
      const scale = TILE_PX * dpr;
      const world = [
        scale, 0, 0, scale,
        Math.round(canvas.width / 2 - cam.x * scale),
        Math.round(canvas.height / 2 - cam.y * scale),
      ];
      ctx.setTransform(...world);
      drawMap(ctx, layers);
      drawExit(ctx, map.exit, now);
      drawReactor(ctx, map.reactor, now);
      const target = game.interactTarget(); // what E would do
      drawDoors(ctx, map.doors, target?.kind === 'door' ? target.door : null);
      for (const item of game.pickups) drawPickup(ctx, item);
      // Enemies under players (so a downed player stays visible), downed players
      // under standing ones, and ours last among those so it's on top.
      for (const enemy of enemies) drawEnemy(ctx, enemy);
      for (const player of players) if (player.down) drawPlayer(ctx, player);
      for (const player of players) if (!player.down) drawPlayer(ctx, player);
      for (const bullet of game.bulletsAt(now)) drawBullet(ctx, bullet);

      // Darkness over everything that isn't lit and in sight.
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.globalCompositeOperation = 'source-over';
      dctx.fillStyle = COLORS.dark;
      dctx.fillRect(0, 0, dark.width, dark.height);
      dctx.setTransform(...world);
      dctx.globalCompositeOperation = 'destination-out';
      paintLight(dctx, scene);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(dark, 0, 0);

      // Sight stops at the reactor's edge like at a wall, which would leave
      // most of the block in the dark. It glows, so once any side of it is in
      // sight, draw the whole block (and its dial, below) over the darkness.
      const { reactor } = map;
      const sides = [
        [reactor.x + reactor.w / 2, reactor.y - 0.05], [reactor.x + reactor.w / 2, reactor.y + reactor.h + 0.05],
        [reactor.x - 0.05, reactor.y + reactor.h / 2], [reactor.x + reactor.w + 0.05, reactor.y + reactor.h / 2],
      ];
      const reactorInSight = sides.some(([x, y]) => canSee(scene, x, y));
      if (reactorInSight) {
        ctx.setTransform(...world);
        drawReactor(ctx, reactor, now, { glow: false });
      }

      // Overlay pass, in CSS pixels. Health bars only show for what we can
      // see; teammates' names always show, so we can find each other.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const enemy of enemies) {
        if (enemy.hp >= ENEMY_MAX_HP || !canSee(scene, enemy.x, enemy.y)) continue;
        const pos = toScreen(enemy.x, enemy.y - ENEMY_RADIUS);
        drawEnemyHealth(ctx, pos.x, pos.y - 4, enemy.hp);
      }
      for (const player of players) {
        const pos = toScreen(player.x, player.y - PLAYER_SIZE / 2);
        const seen = player.id === game.you || canSee(scene, player.x, player.y);
        drawTag(ctx, pos.x, pos.y - 5, player, seen);
      }
      // The dial sits on the reactor's face, so it never covers players standing around it.
      if (reactorInSight && showDial) {
        const dialAt = toScreen(reactor.x + reactor.w / 2, reactor.y + reactor.h / 2);
        drawDial(ctx, dialAt.x, dialAt.y + DIAL_RADIUS * 0.5, DIAL_RADIUS, game.reactor.temperature);
      }

      if (target?.kind === 'reactor') {
        const pos = toScreen(reactor.x + reactor.w / 2, reactor.y + reactor.h);
        drawPrompt(ctx, pos.x, pos.y + 6, 'E', 'Reactor controls', { below: true });
      } else if (target?.kind === 'door') {
        const { door } = target;
        const pos = toScreen(door.x + door.w / 2, door.y);
        drawPrompt(ctx, pos.x, pos.y - 10, 'E', door.open ? 'Close' : 'Open');
      } else if (target?.kind === 'hatch') {
        // Below the hatch, since the name tag of whoever is on it sits above.
        const { hatch, zone } = map.exit;
        const escaping = players.filter((p) => !p.down && pointInRect(p, zone)).length;
        const pos = toScreen(hatch.x + hatch.w / 2, hatch.y + hatch.h);
        const label = escaping > 1 ? `Escape with ${escaping} players` : 'Escape';
        drawPrompt(ctx, pos.x, pos.y + 6, 'E', label, { below: true });
      }
      // Pickup prompts go below the item too, for players standing next to it.
      const stack = game.down ? null : nearestPickup(game.pickups, game.self);
      if (stack) {
        const pos = toScreen(stack.x, stack.y + PICKUP_SIZE / 2);
        if (target?.kind === 'pickup') drawPrompt(ctx, pos.x, pos.y + 4, 'E', 'Take ammo', { below: true });
        else if (!canTake(stack, game.ammoLeft)) drawPrompt(ctx, pos.x, pos.y + 4, null, 'Ammo full', { below: true });
      }
      drawHurt(ctx, viewW, viewH, 1 - (now - game.hurtAt) / HURT_FLASH_MS);
      if (fullMap) drawFullMap(ctx, layers.fullMap, map, players, enemies, game.pickups, cam, viewW, viewH);
      else if (showMinimap) minimap.draw(ctx, viewW, self, others, now);
    },
  };
}

// Camera position along one axis: follow the player, but stop at the map edges.
// If the whole map fits on screen, center it instead.
function follow(pos, mapSize, viewSize) {
  if (mapSize <= viewSize) return mapSize / 2;
  return Math.min(Math.max(pos, viewSize / 2), mapSize - viewSize / 2);
}

// Static geometry, built once per map as paths in tile coordinates.
function buildLayers(map) {
  const { width, height, tiles, rooms } = map;
  const walkable = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const tile = tiles[y * width + x];
    return tile === TILE.FLOOR || tile === TILE.DOOR;
  };

  const floor = new Path2D();
  const walls = new Path2D();
  const wallEdges = new Path2D();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = tiles[y * width + x];
      if (tile === TILE.FLOOR || tile === TILE.DOOR) {
        floor.rect(x, y, 1, 1);
      } else if (tile === TILE.WALL) {
        walls.rect(x, y, 1, 1);
        if (walkable(x, y + 1)) wallEdges.rect(x, y + 1 - WALL_EDGE, 1, WALL_EDGE);
        if (walkable(x, y - 1)) wallEdges.rect(x, y, 1, WALL_EDGE);
        if (walkable(x + 1, y)) wallEdges.rect(x + 1 - WALL_EDGE, y, WALL_EDGE, 1);
        if (walkable(x - 1, y)) wallEdges.rect(x, y, WALL_EDGE, 1);
      }
    }
  }

  const roomFloors = new Path2D();
  const grid = new Path2D();
  for (const room of rooms) {
    roomFloors.rect(room.x, room.y, room.w, room.h);
    for (let x = room.x + 1; x < room.x + room.w; x++) {
      grid.moveTo(x, room.y);
      grid.lineTo(x, room.y + room.h);
    }
    for (let y = room.y + 1; y < room.y + room.h; y++) {
      grid.moveTo(room.x, y);
      grid.lineTo(room.x + room.w, y);
    }
  }

  return { floor, roomFloors, grid, walls, wallEdges, fullMap: buildFullMap(map) };
}

function buildFullMap({ width, height, tiles, rooms }) {
  const res = 2; // canvas pixels per minimap pixel, so it stays sharp on hi-dpi screens
  const px = FULL_MAP_PX * res;
  const canvas = document.createElement('canvas');
  canvas.width = width * px;
  canvas.height = height * px;
  const ctx = canvas.getContext('2d');

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = tiles[y * width + x];
      if (tile === TILE.VOID) continue;
      ctx.fillStyle = tile === TILE.WALL ? COLORS.miniWall : COLORS.miniCorridor;
      ctx.fillRect(x * px, y * px, px, px);
    }
  }
  ctx.fillStyle = COLORS.miniRoom;
  for (const room of rooms) ctx.fillRect(room.x * px, room.y * px, room.w * px, room.h * px);
  return canvas;
}

function drawMap(ctx, layers) {
  ctx.fillStyle = COLORS.corridor;
  ctx.fill(layers.floor);
  ctx.fillStyle = COLORS.room;
  ctx.fill(layers.roomFloors);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1 / TILE_PX;
  ctx.stroke(layers.grid);
  ctx.fillStyle = COLORS.wall;
  ctx.fill(layers.walls);
  ctx.fillStyle = COLORS.wallEdge;
  ctx.fill(layers.wallEdges);
}

function drawDoors(ctx, doors, target) {
  for (const door of doors) {
    if (door.open) {
      ctx.fillStyle = COLORS.doorOpen;
      ctx.fillRect(door.x, door.y, door.w, door.h);
    } else {
      // Two panels meeting at a seam across the middle of the doorway.
      ctx.fillStyle = COLORS.door;
      ctx.fillRect(door.x, door.y, door.w, door.h);
      ctx.fillStyle = COLORS.doorSeam;
      if (door.w > door.h) ctx.fillRect(door.x + door.w / 2 - 0.04, door.y, 0.08, door.h);
      else ctx.fillRect(door.x, door.y + door.h / 2 - 0.04, door.w, 0.08);
    }
  }

  if (target) {
    ctx.strokeStyle = COLORS.highlight;
    ctx.lineWidth = 2 / TILE_PX;
    ctx.strokeRect(target.x, target.y, target.w, target.h);
  }
}

// A colored square; downed players are greyed out and crossed through.
function drawPlayer(ctx, { x, y, color, away, down }) {
  const half = PLAYER_SIZE / 2;
  const inset = 1.5 / TILE_PX;
  ctx.globalAlpha = away ? AWAY_ALPHA : 1;
  ctx.fillStyle = down ? COLORS.downed : color;
  ctx.fillRect(x - half, y - half, PLAYER_SIZE, PLAYER_SIZE);
  ctx.strokeStyle = down ? color : COLORS.playerEdge;
  ctx.lineWidth = 3 / TILE_PX;
  ctx.strokeRect(x - half + inset, y - half + inset, PLAYER_SIZE - 2 * inset, PLAYER_SIZE - 2 * inset);
  if (down) {
    const r = half * 0.55;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawEnemy(ctx, { x, y }) {
  ctx.beginPath();
  ctx.arc(x, y, ENEMY_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.enemy;
  ctx.fill();
  ctx.lineWidth = 3 / TILE_PX;
  ctx.strokeStyle = COLORS.enemyEdge;
  ctx.stroke();
}

// The reactor: a blue block with a softly pulsing glow, the same whatever
// its temperature. With `glow` false, just the block.
function drawReactor(ctx, rect, now, { glow = true } = {}) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);
  for (let i = 5; glow && i >= 1; i--) {
    const pad = i * 0.15;
    ctx.fillStyle = `rgba(${COLORS.reactorGlow}, ${0.09 * (0.6 + 0.4 * pulse)})`;
    ctx.fillRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2);
  }
  ctx.fillStyle = COLORS.reactor;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const inset = 0.6;
  ctx.fillStyle = COLORS.reactorCore;
  ctx.fillRect(rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2);
  ctx.strokeStyle = COLORS.reactorEdge;
  ctx.lineWidth = 3 / TILE_PX;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
}

// A temperature dial: a half circle from cold (left) through the green band
// (top) to meltdown (right), with a needle. (x, y) is the middle of its flat
// bottom edge and r the radius of the colored band's center line; the whole
// dial reaches DIAL_EXTENT * r from (x, y). Exported so the reactor menu can
// draw a bigger one.
export const DIAL_EXTENT = 1.2;
export function drawDial(ctx, x, y, r, temperature) {
  const width = r * (DIAL_EXTENT - 1);
  const angle = (t) => Math.PI + (Math.min(100, Math.max(0, t)) / 100) * Math.PI;

  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.arc(x, y, r + width, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fill();

  const band = (from, to, color) => {
    ctx.beginPath();
    ctx.arc(x, y, r, angle(from), angle(to));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ctx.lineCap = 'butt';
  band(0, REACTOR_POWER_MIN, COLORS.dialCold);
  band(REACTOR_POWER_MIN, REACTOR_OVERHEAT_MIN, COLORS.dialStable);
  band(REACTOR_OVERHEAT_MIN, 100, COLORS.dialHot);

  const a = angle(temperature);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * (r + width / 2), y + Math.sin(a) * (r + width / 2));
  ctx.strokeStyle = COLORS.highlight;
  ctx.lineWidth = Math.max(2, r * 0.07);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = COLORS.highlight;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2.5, r * 0.1), 0, Math.PI * 2);
  ctx.fill();
}

// The extraction zone as a tinted square with a dashed edge, and the hatch in
// its middle as a bright panel with a pulsing glow.
function drawExit(ctx, { hatch, zone }, now) {
  ctx.fillStyle = `rgba(${COLORS.exitGlow}, 0.06)`;
  ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
  ctx.strokeStyle = `rgba(${COLORS.exitGlow}, 0.55)`;
  ctx.lineWidth = 2 / TILE_PX;
  ctx.setLineDash([0.4, 0.25]);
  ctx.strokeRect(zone.x + 0.05, zone.y + 0.05, zone.w - 0.1, zone.h - 0.1);
  ctx.setLineDash([]);

  const pulse = 0.5 + 0.5 * Math.sin(now / 350);
  for (let i = 4; i >= 1; i--) {
    const pad = i * 0.12;
    ctx.fillStyle = `rgba(${COLORS.exitGlow}, ${0.05 + 0.06 * pulse})`;
    ctx.fillRect(hatch.x - pad, hatch.y - pad, hatch.w + pad * 2, hatch.h + pad * 2);
  }
  ctx.fillStyle = COLORS.exit;
  ctx.fillRect(hatch.x, hatch.y, hatch.w, hatch.h);
  // Panel seams, so it reads as a hatch rather than a floor tile.
  const inset = 0.18;
  ctx.strokeStyle = COLORS.exitDark;
  ctx.lineWidth = 3 / TILE_PX;
  ctx.strokeRect(hatch.x + inset, hatch.y + inset, hatch.w - inset * 2, hatch.h - inset * 2);
  ctx.beginPath();
  ctx.moveTo(hatch.x + hatch.w / 2, hatch.y + inset);
  ctx.lineTo(hatch.x + hatch.w / 2, hatch.y + hatch.h - inset);
  ctx.stroke();
}

function drawPickup(ctx, { kind, x, y }) {
  const image = SPRITES[kind];
  if (!image?.complete || !image.naturalWidth) return;
  const half = PICKUP_SIZE / 2;
  ctx.drawImage(image, x - half, y - half, PICKUP_SIZE, PICKUP_SIZE);
}

// A small yellow point with a short fading trail behind it.
function drawBullet(ctx, { x, y, dx, dy, flown }) {
  const trail = Math.min(flown, BULLET_TRAIL);
  ctx.strokeStyle = COLORS.bulletTrail;
  ctx.lineWidth = BULLET_RADIUS * 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - dx * trail, y - dy * trail);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.lineCap = 'butt';

  ctx.fillStyle = COLORS.bullet;
  ctx.beginPath();
  ctx.arc(x, y, BULLET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

// Remaining HP as segments, bottom-centered on (x, y).
function drawEnemyHealth(ctx, x, y, hp) {
  const { w, h } = ENEMY_HEALTH_BAR;
  const left = Math.round(x - w / 2);
  const top = Math.round(y - h);
  const segment = w / ENEMY_MAX_HP;
  ctx.fillStyle = COLORS.hpTrack;
  ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
  ctx.fillStyle = COLORS.enemy;
  for (let i = 0; i < hp; i++) ctx.fillRect(left + i * segment, top, segment - 1, h);
}

// Health bar with the name above it, stacked upward from (x, y), the top edge
// of the player. Downed players get a label instead of a bar, and players
// we can't see (`seen` false) just the name.
function drawTag(ctx, x, y, { name, away, down, hp }, seen) {
  ctx.globalAlpha = away ? AWAY_ALPHA * 2 : 1;

  let nameY = y;
  if (!down && seen) {
    const { w, h } = HEALTH_BAR;
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h);
    const frac = Math.max(0, Math.min(1, hp / PLAYER_MAX_HP));
    ctx.fillStyle = COLORS.hpTrack;
    ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
    ctx.fillStyle = frac > 0.5 ? COLORS.hpHigh : frac > 0.25 ? COLORS.hpMid : COLORS.hpLow;
    ctx.fillRect(left, top, w * frac, h);
    nameY = top - 4;
  }

  const status = [down && 'down', away && 'disconnected'].filter(Boolean).join(', ');
  const label = status ? `${name} (${status})` : name;
  if (label) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.void;
    ctx.strokeText(label, x, nameY);
    ctx.fillStyle = COLORS.highlight;
    ctx.fillText(label, x, nameY);
  }
  ctx.globalAlpha = 1;
}

// Red glow around the screen edges after taking damage; `strength` 0..1.
function drawHurt(ctx, viewW, viewH, strength) {
  if (strength <= 0) return;
  const cx = viewW / 2;
  const cy = viewH / 2;
  const gradient = ctx.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.6, cx, cy, Math.hypot(cx, cy));
  gradient.addColorStop(0, `rgba(${COLORS.hurt}, 0)`);
  gradient.addColorStop(1, `rgba(${COLORS.hurt}, ${0.45 * strength})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewW, viewH);
}

// A "[key] label" hint centered above (x, y), or below it with `below`, e.g.
// "[E] Open". With no key, just the label.
function drawPrompt(ctx, x, y, key, label, { below = false } = {}) {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const keyW = key ? Math.max(18, ctx.measureText(key).width + 10) : 0;
  const gap = key ? 6 : 4;
  const labelW = ctx.measureText(label).width;
  const w = keyW + gap + labelW + 12;
  const h = 24;
  const left = Math.round(x - w / 2);
  const top = Math.round(below ? y : y - h);

  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 6);
  ctx.fill();

  if (key) {
    ctx.fillStyle = COLORS.highlight;
    ctx.beginPath();
    ctx.roundRect(left + 4, top + 3, keyW, h - 6, 4);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.void;
    ctx.fillText(key, left + 4 + keyW / 2, top + h / 2 + 1);
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.highlight;
  ctx.fillText(label, left + 4 + keyW + gap, top + h / 2 + 1);
}

// The whole level with everything on it (Shift+M), for testing.
function drawFullMap(ctx, image, map, players, enemies, pickups, cam, viewW, viewH) {
  const s = FULL_MAP_PX;
  const w = map.width * s;
  const h = map.height * s;
  const left = viewW - w - MARGIN;
  const top = MARGIN;

  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(left - 8, top - 8, w + 16, h + 16, 8);
  ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, left, top, w, h);

  ctx.fillStyle = COLORS.door;
  for (const door of map.doors) {
    if (!door.open) ctx.fillRect(left + door.x * s, top + door.y * s, door.w * s, door.h * s);
  }

  // Outline of what the main view currently shows.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(240, 246, 252, 0.4)';
  ctx.lineWidth = 1;
  const tilesW = viewW / TILE_PX;
  const tilesH = viewH / TILE_PX;
  ctx.strokeRect(left + (cam.x - tilesW / 2) * s, top + (cam.y - tilesH / 2) * s, tilesW * s, tilesH * s);
  ctx.restore();

  const { reactor } = map;
  ctx.fillStyle = COLORS.reactorCore;
  ctx.fillRect(left + reactor.x * s, top + reactor.y * s, reactor.w * s, reactor.h * s);

  const { hatch } = map.exit;
  ctx.fillStyle = COLORS.exit;
  ctx.fillRect(left + hatch.x * s - 1, top + hatch.y * s - 1, hatch.w * s + 2, hatch.h * s + 2);

  ctx.fillStyle = COLORS.bullet;
  for (const { x, y } of pickups) ctx.fillRect(left + x * s - 2, top + y * s - 2, 4, 4);

  ctx.fillStyle = COLORS.enemy;
  for (const { x, y } of enemies) ctx.fillRect(left + x * s - 1.5, top + y * s - 1.5, 3, 3);

  for (const { x, y, color, away, down } of players) {
    ctx.globalAlpha = away ? AWAY_ALPHA : 1;
    ctx.fillStyle = COLORS.void;
    ctx.fillRect(left + x * s - 3.5, top + y * s - 3.5, 7, 7);
    ctx.fillStyle = down ? COLORS.downed : color;
    ctx.fillRect(left + x * s - 2.5, top + y * s - 2.5, 5, 5);
  }
  ctx.globalAlpha = 1;
}
