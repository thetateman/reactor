import { KEY, KEY_MASK, SIM_STEP, TICK_RATE } from '../shared/constants.js';
import { nearestDoor, roomCenter, serializeMap } from '../shared/map.js';
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
//
// The player list is fixed when the game starts. A player whose connection
// drops keeps their place (and position) and can be reattached with connect().
export class Game {
  constructor(seed, playerIds) {
    this.seed = seed;
    this.map = generateMap(seed);
    this.players = new Map();

    const spawns = spawnPoints(this.map, playerIds.length);
    playerIds.forEach((id, i) => {
      this.players.set(id, { id, socket: null, ...spawns[i], ...freshInputState() });
    });

    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stop() {
    clearInterval(this.timer);
  }

  has(id) {
    return this.players.has(id);
  }

  get size() {
    return this.players.size;
  }

  // Attaches a connection to a player and sends them the full game.
  // Input numbering restarts, because the client starts a fresh prediction.
  connect(id, socket) {
    const player = this.players.get(id);
    if (!player) return;
    Object.assign(player, { socket, ...freshInputState() });
    send(socket, {
      type: 'game',
      seed: this.seed,
      you: id,
      map: serializeMap(this.map),
      players: this.playerPositions(),
    });
  }

  disconnect(id) {
    const player = this.players.get(id);
    if (player) Object.assign(player, { socket: null, ...freshInputState() });
  }

  removePlayer(id) {
    this.players.delete(id);
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
      if (player.socket) send(player.socket, { type: 'state', ack: player.lastSeq, players });
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
    for (const player of this.players.values()) {
      if (player.socket) send(player.socket, msg);
    }
  }

  playerPositions() {
    return [...this.players.values()].map(({ id, x, y }) => ({ id, x, y }));
  }
}

function freshInputState() {
  return { inputs: [], lastSeq: 0, queuedSeq: 0, budget: 0 };
}

// Tile centers in the spawn room, nearest its middle first, one per player.
function spawnPoints(map, count) {
  const room = map.rooms[map.spawnRoom];
  const center = roomCenter(room);
  const points = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) points.push({ x: x + 0.5, y: y + 0.5 });
  }
  const dist = (p) => Math.hypot(p.x - center.x, p.y - center.y);
  points.sort((a, b) => dist(a) - dist(b));
  return points.slice(0, count);
}
