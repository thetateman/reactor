import { KEY, KEY_MASK, SIM_STEP, TICK_RATE } from '../shared/constants.js';
import { nearestDoor, serializeMap } from '../shared/map.js';
import { bodyOverlapsRect, stepPlayer } from '../shared/physics.js';
import { generateMap } from './mapgen.js';
import { send } from './net.js';

const MAX_QUEUED_INPUTS = 120;
// Seconds of movement a player can bank while idle or lagging. Inputs are only
// applied while there is budget, so a client can't move faster than real time.
const MAX_INPUT_BUDGET = 0.5;

// One running match. The server owns all state: clients send input commands
// (one per movement step, numbered by `seq`) and receive authoritative positions
// along with the last `seq` applied, which they use to reconcile prediction.
export class Game {
  constructor(seed) {
    this.seed = seed;
    this.map = generateMap(seed);
    this.players = new Map();
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stop() {
    clearInterval(this.timer);
  }

  addPlayer(id, socket) {
    const { x, y } = this.map.spawn;
    this.players.set(id, { id, socket, x, y, inputs: [], lastSeq: 0, queuedSeq: 0, budget: 0 });
    send(socket, {
      type: 'game',
      seed: this.seed,
      you: id,
      map: serializeMap(this.map),
      players: this.playerPositions(),
    });
  }

  queueInput(id, { seq, keys }) {
    const player = this.players.get(id);
    if (!player || !Number.isInteger(seq) || !Number.isInteger(keys)) return;
    if (seq <= player.queuedSeq || player.inputs.length >= MAX_QUEUED_INPUTS) return;
    player.queuedSeq = seq;
    player.inputs.push({ seq, keys: keys & KEY_MASK });
  }

  tick() {
    const now = performance.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;

    for (const player of this.players.values()) {
      player.budget = Math.min(player.budget + elapsed, MAX_INPUT_BUDGET);
      while (player.inputs.length && player.budget >= SIM_STEP - 1e-9) {
        const { seq, keys } = player.inputs.shift();
        player.budget -= SIM_STEP;
        stepPlayer(player, keys, this.map);
        if (keys & KEY.INTERACT) this.interact(player);
        player.lastSeq = seq;
      }
    }

    const players = this.playerPositions();
    for (const player of this.players.values()) {
      send(player.socket, { type: 'state', ack: player.lastSeq, players });
    }
  }

  interact(player) {
    const door = nearestDoor(this.map, player.x, player.y);
    if (!door) return;
    if (door.open && [...this.players.values()].some((p) => bodyOverlapsRect(p, door))) return;
    door.open = !door.open;
    this.broadcast({ type: 'door', id: door.id, open: door.open });
  }

  broadcast(msg) {
    for (const player of this.players.values()) send(player.socket, msg);
  }

  playerPositions() {
    return [...this.players.values()].map(({ id, x, y }) => ({ id, x, y }));
  }
}
