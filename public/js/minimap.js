import { TILE } from '/shared/constants.js';
import { roomOf } from '/shared/map.js';
import { loadPref, savePref } from './prefs.js';

// The player's own map: only the tiles they've seen, drawn as a small
// north-up window centered on them, with teammates as dots. No enemies, no
// exit, no pickups, and doors without their open/closed state. A room the
// player has been inside is shown in full whenever its light is on. What's
// been seen is kept in the browser, so a page refresh mid-level doesn't lose it.

const PX = 7; // CSS pixels per tile
const RES = 2; // canvas pixels per CSS pixel, so it's sharp on hi-dpi screens
const VIEW = { w: 34, h: 22 }; // tiles shown: twice the control room each way
const MARGIN = 16;
const SAVE_EVERY_MS = 2000;

const COLORS = {
  panel: 'rgba(7, 9, 12, 0.75)',
  border: 'rgba(240, 246, 252, 0.15)',
  room: '#3a4554',
  wall: '#5c6878',
  door: '#8b949e',
  reactor: '#79c0ff',
  self: '#f0f6fc',
};

let current = null; // the minimap of the game in progress, saved when the page closes
window.addEventListener('pagehide', () => current?.save());

export class Minimap {
  // `gameId` tells this level's saved exploration apart from older ones.
  constructor(map, gameId) {
    this.map = map;
    this.gameId = gameId;
    this.explored = new Uint8Array(map.width * map.height);
    this.layer = document.createElement('canvas');
    this.layer.width = map.width * PX * RES;
    this.layer.height = map.height * PX * RES;
    this.ctx = this.layer.getContext('2d');
    this.visited = new Set(); // ids of rooms we've been inside
    this.revealedRooms = new Set(); // visited rooms already shown in full
    this.unsaved = false;
    this.lastSave = 0;
    this.load();
    current = this;
  }

  // Marks a tile as seen.
  reveal(index) {
    if (this.explored[index]) return;
    this.explored[index] = 1;
    this.paint(index);
    this.unsaved = true;
  }

  // Notes which room we're inside, and shows every visited room in full
  // while it's lit (lights[roomId]), even if we were there in the dark.
  visit(eye, lights) {
    const room = roomOf(this.map, eye.x, eye.y);
    if (room >= 0 && !this.visited.has(room)) {
      this.visited.add(room);
      this.unsaved = true;
    }
    for (const id of this.visited) {
      if (!lights[id] || this.revealedRooms.has(id)) continue;
      // The room's floor and the walls around it.
      for (const r of this.map.rooms[id].rects) {
        for (let y = r.y - 1; y <= r.y + r.h; y++) {
          for (let x = r.x - 1; x <= r.x + r.w; x++) this.reveal(y * this.map.width + x);
        }
      }
      this.revealedRooms.add(id);
    }
  }

  paint(index) {
    const { width, tiles } = this.map;
    const tile = tiles[index];
    if (tile === TILE.VOID) return;
    this.ctx.fillStyle =
      tile === TILE.WALL ? COLORS.wall
      : tile === TILE.DOOR ? COLORS.door
      : tile === TILE.REACTOR ? COLORS.reactor
      : COLORS.room;
    const size = PX * RES;
    this.ctx.fillRect((index % width) * size, Math.floor(index / width) * size, size, size);
  }

  // Draws the window around `self` in the top-right corner (CSS pixels).
  // `teammates` are [{ x, y, color, away }].
  draw(ctx, viewW, self, teammates, now) {
    const w = VIEW.w * PX;
    const h = VIEW.h * PX;
    const left = viewW - w - MARGIN;
    const top = MARGIN;

    ctx.fillStyle = COLORS.panel;
    ctx.beginPath();
    ctx.roundRect(left - 8, top - 8, w + 16, h + 16, 8);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, w, h);
    ctx.clip();
    // Map coordinates to the panel, with `self` in the middle.
    const toX = (x) => left + w / 2 + (x - self.x) * PX;
    const toY = (y) => top + h / 2 + (y - self.y) * PX;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.layer, toX(0), toY(0), this.map.width * PX, this.map.height * PX);

    for (const { x, y, color, away } of teammates) {
      ctx.globalAlpha = away ? 0.4 : 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(toX(x) - 3.5, toY(y) - 3.5, 7, 7);
      ctx.fillStyle = color;
      ctx.fillRect(toX(x) - 2.5, toY(y) - 2.5, 5, 5);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.self;
    ctx.beginPath();
    ctx.arc(toX(self.x), toY(self.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);

    if (this.unsaved && now - this.lastSave > SAVE_EVERY_MS) this.save(now);
  }

  save(now = performance.now()) {
    if (!this.unsaved) return;
    let bits = '';
    for (const seen of this.explored) bits += seen ? '1' : '0';
    savePref('explored', JSON.stringify({ game: this.gameId, bits, visited: [...this.visited] }));
    this.unsaved = false;
    this.lastSave = now;
  }

  load() {
    try {
      const saved = JSON.parse(loadPref('explored', 'null'));
      if (saved?.game !== this.gameId || saved.bits.length !== this.explored.length) return;
      this.visited = new Set(saved.visited ?? []);
      for (let i = 0; i < saved.bits.length; i++) {
        if (saved.bits[i] === '1') {
          this.explored[i] = 1;
          this.paint(i);
        }
      }
    } catch {
      // Unreadable; start fresh.
    }
  }
}
