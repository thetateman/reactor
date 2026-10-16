import { PLAYER_SIZE, TILE } from '/shared/constants.js';
import { nearestDoor } from '/shared/map.js';

const TILE_PX = 32; // CSS pixels per tile in the main view
const MINIMAP_PX = 3; // CSS pixels per tile in the minimap
const MARGIN = 16;
const WALL_EDGE = 0.12; // lit strip along wall faces, in tiles

const COLORS = {
  void: '#07090c',
  corridor: '#151a21',
  room: '#1b222c',
  grid: 'rgba(255, 255, 255, 0.04)',
  wall: '#2b333e',
  wallEdge: '#4a5667',
  door: '#c99a2e',
  doorSeam: '#6b4f12',
  doorOpen: 'rgba(201, 154, 46, 0.18)',
  self: '#3fb950',
  selfEdge: '#1b5e28',
  other: '#58a6ff',
  otherEdge: '#1f4f8a',
  highlight: '#f0f6fc',
  panel: 'rgba(7, 9, 12, 0.75)',
  miniRoom: '#3a4554',
  miniCorridor: '#2c3541',
  miniWall: '#5c6878',
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let layers = null;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  return {
    setMap(map) {
      layers = buildLayers(map);
    },

    clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COLORS.void;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },

    draw(game, alpha) {
      const { map } = game;
      const self = game.selfAt(alpha);
      const viewW = canvas.width / dpr;
      const viewH = canvas.height / dpr;
      const cam = {
        x: follow(self.x, map.width, viewW / TILE_PX),
        y: follow(self.y, map.height, viewH / TILE_PX),
      };

      this.clear();

      // World pass, in tile units.
      const scale = TILE_PX * dpr;
      ctx.setTransform(
        scale, 0, 0, scale,
        Math.round(canvas.width / 2 - cam.x * scale),
        Math.round(canvas.height / 2 - cam.y * scale),
      );
      drawMap(ctx, layers);
      const target = nearestDoor(map, game.self.x, game.self.y);
      drawDoors(ctx, map.doors, target);
      for (const other of game.others) drawPlayer(ctx, other, COLORS.other, COLORS.otherEdge);
      drawPlayer(ctx, self, COLORS.self, COLORS.selfEdge);

      // Overlay pass, in CSS pixels.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (target) {
        const sx = (target.x + target.w / 2 - cam.x) * TILE_PX + viewW / 2;
        const sy = (target.y - cam.y) * TILE_PX + viewH / 2;
        drawPrompt(ctx, sx, sy - 10, target.open ? 'Close' : 'Open');
      }
      drawMinimap(ctx, layers.minimap, map, self, cam, viewW, viewH);
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

  return { floor, roomFloors, grid, walls, wallEdges, minimap: buildMinimap(map) };
}

function buildMinimap({ width, height, tiles, rooms }) {
  const res = 2; // canvas pixels per minimap pixel, so it stays sharp on hi-dpi screens
  const px = MINIMAP_PX * res;
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

function drawPlayer(ctx, pos, fill, edge) {
  const half = PLAYER_SIZE / 2;
  const inset = 1.5 / TILE_PX;
  ctx.fillStyle = fill;
  ctx.fillRect(pos.x - half, pos.y - half, PLAYER_SIZE, PLAYER_SIZE);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 3 / TILE_PX;
  ctx.strokeRect(pos.x - half + inset, pos.y - half + inset, PLAYER_SIZE - 2 * inset, PLAYER_SIZE - 2 * inset);
}

// A "[E] Open" hint centered above (x, y).
function drawPrompt(ctx, x, y, label) {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const key = 'E';
  const keyW = 18;
  const gap = 6;
  const labelW = ctx.measureText(label).width;
  const w = keyW + gap + labelW + 12;
  const h = 24;
  const left = Math.round(x - w / 2);
  const top = Math.round(y - h);

  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 6);
  ctx.fill();

  ctx.fillStyle = COLORS.highlight;
  ctx.beginPath();
  ctx.roundRect(left + 4, top + 3, keyW, h - 6, 4);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.void;
  ctx.fillText(key, left + 4 + keyW / 2, top + h / 2 + 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.highlight;
  ctx.fillText(label, left + 4 + keyW + gap, top + h / 2 + 1);
}

function drawMinimap(ctx, image, map, self, cam, viewW, viewH) {
  const s = MINIMAP_PX;
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

  ctx.fillStyle = COLORS.self;
  ctx.fillRect(left + self.x * s - 2.5, top + self.y * s - 2.5, 5, 5);
}
