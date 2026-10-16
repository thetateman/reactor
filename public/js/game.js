import { deserializeMap } from '/shared/map.js';
import { stepPlayer } from '/shared/physics.js';
import { send } from './net.js';

// Other players are drawn this far (ms) behind the latest server state, so
// there are usually two snapshots to blend between.
const INTERPOLATION_DELAY = 100;
const SNAPSHOT_HISTORY = 1000;

// The client's view of a running game. Our own player is predicted: each input
// is applied locally right away and sent to the server. When the server reports
// where it has us, inputs it hasn't applied yet are replayed on top of that.
// Other players are interpolated between the snapshots the server sends.
export class ClientGame {
  constructor({ seed, you, map, players }) {
    this.seed = seed;
    this.you = you;
    this.map = deserializeMap(map);
    this.self = { x: 0, y: 0 };
    this.prev = { x: 0, y: 0 };
    this.snapshots = []; // { time, others: Map<id, { x, y }> }, oldest first
    this.pending = [];
    this.seq = 0;
    this.applyPlayers(players);
    this.prev = { ...this.self };
  }

  // Runs one fixed movement step with the given key bits.
  step(keys) {
    this.prev = { ...this.self };
    if (!keys) return;

    const input = { seq: ++this.seq, keys };
    stepPlayer(this.self, keys, this.map);
    this.pending.push(input);
    send('input', input);
  }

  applyState({ ack, players }) {
    this.pending = this.pending.filter((input) => input.seq > ack);
    this.applyPlayers(players);
    for (const input of this.pending) stepPlayer(this.self, input.keys, this.map);
  }

  applyDoor({ id, open }) {
    this.map.doors[id].open = open;
  }

  applyPlayers(players) {
    const now = performance.now();
    const others = new Map();
    for (const { id, x, y } of players) {
      if (id === this.you) {
        this.self.x = x;
        this.self.y = y;
      } else {
        others.set(id, { x, y });
      }
    }

    this.snapshots.push({ time: now, others });
    while (this.snapshots.length > 2 && this.snapshots[0].time < now - SNAPSHOT_HISTORY) {
      this.snapshots.shift();
    }
  }

  // Other players as [{ id, x, y }], blended between the two snapshots around
  // `now - INTERPOLATION_DELAY`.
  othersAt(now) {
    const t = now - INTERPOLATION_DELAY;
    const snaps = this.snapshots;
    let i = 0;
    while (i + 1 < snaps.length && snaps[i + 1].time <= t) i++;
    const from = snaps[i];
    const to = snaps[i + 1];

    if (!to || t <= from.time) {
      return [...from.others].map(([id, p]) => ({ id, ...p }));
    }
    const k = (t - from.time) / (to.time - from.time);
    return [...to.others].map(([id, p]) => {
      const q = from.others.get(id) ?? p;
      return { id, x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k };
    });
  }

  // Our position for drawing, blended between the last two steps.
  selfAt(alpha) {
    return {
      x: this.prev.x + (this.self.x - this.prev.x) * alpha,
      y: this.prev.y + (this.self.y - this.prev.y) * alpha,
    };
  }
}
