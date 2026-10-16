import { deserializeMap } from '/shared/map.js';
import { stepPlayer } from '/shared/physics.js';
import { send } from './net.js';

// The client's view of a running game. Our own player is predicted: each input
// is applied locally right away and sent to the server. When the server reports
// where it has us, inputs it hasn't applied yet are replayed on top of that.
export class ClientGame {
  constructor({ seed, you, map, players }) {
    this.seed = seed;
    this.you = you;
    this.map = deserializeMap(map);
    this.self = { x: 0, y: 0 };
    this.prev = { x: 0, y: 0 };
    this.others = [];
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
    const me = players.find((p) => p.id === this.you);
    this.self.x = me.x;
    this.self.y = me.y;
    this.others = players.filter((p) => p.id !== this.you);
  }

  // Our position for drawing, blended between the last two steps.
  selfAt(alpha) {
    return {
      x: this.prev.x + (this.self.x - this.prev.x) * alpha,
      y: this.prev.y + (this.self.y - this.prev.y) * alpha,
    };
  }
}
